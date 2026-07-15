// used for "one case":
// Redirect-URL variants with proxy mode OFF (plain 302 redirect to an external domain SplitLab doesn't serve)
import { NextRequest, NextResponse } from 'next/server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function GET(request: NextRequest) {
  const script = buildTrackerScript(APP_URL);
  return new NextResponse(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      ...corsHeaders(request),
    },
  });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: corsHeaders(request) });
}

function buildTrackerScript(appUrl: string): string {
  return `/**
 * SplitLab Conversion Tracker v2.0
 * Zero-config tracking. One script tag, no setup needed.
 * <script src="${appUrl}/tracker.js"></script>
 */
(function() {
  "use strict";

  var API_BASE = ${JSON.stringify(appUrl)};
  var EVENT_URL = API_BASE + "/api/event";
  var RESOLVE_URL = API_BASE + "/api/resolve";
  var SCAN_URL = API_BASE + "/api/scan";
  var REGISTER_FIELDS_URL = API_BASE + "/api/register-form-fields";
  var STORAGE_KEY = "sl_tracking";
  var _sent = {};
  var _ctx = null;
  var _scanMode = false;

  // ─── Utility ────────────────────────────────────────────────────────────────

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function send(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: "text/plain" });
        navigator.sendBeacon(EVENT_URL, blob);
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", EVENT_URL, true);
        xhr.withCredentials = false;
        xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
        xhr.send(body);
      }
    } catch(e) {}
  }

  // Context storage is a per-test map: { [testId]: { vid, vh, ts, goals } }.
  // A single-slot value here let a second test's arrival overwrite the first
  // test's context, silently losing its pending url_reached conversions.
  var CTX_TTL = 90 * 24 * 60 * 60 * 1000; // matches the 90-day sl_visitor cookie

  function saveMap(m) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch(e) {}
  }

  function loadMap() {
    try {
      var m = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!m || typeof m !== "object") return {};
      // Pre-map single-slot value ({tid, vid, vh, goals}) must be migrated
      // before any validation or save, or returning visitors lose context
      if (m.tid && m.vid && m.vh) {
        var old = m;
        m = {};
        m[old.tid] = { vid: old.vid, vh: old.vh, ts: Date.now(), goals: old.goals || [] };
        saveMap(m);
      }
      var now = Date.now();
      var changed = false;
      for (var k in m) {
        var entry = m[k];
        if (!entry || !entry.vid || !entry.vh || !entry.ts || now - entry.ts > CTX_TTL) {
          delete m[k];
          changed = true;
        }
      }
      if (changed) saveMap(m);
      return m;
    } catch(e) { return {}; }
  }

  function store(ctx) {
    try {
      if (!ctx || !ctx.tid || !ctx.vid || !ctx.vh) return;
      var m = loadMap();
      m[ctx.tid] = { vid: ctx.vid, vh: ctx.vh, ts: Date.now(), goals: ctx.goals || [] };
      saveMap(m);
    } catch(e) {}
  }

  function load() {
    try {
      // Current test = most-recent entry — preserves single-slot behavior so
      // form/button conversions and leads keep attributing exactly as before
      var m = loadMap();
      var best = null;
      var bestTid = null;
      for (var tid in m) {
        if (!best || m[tid].ts > best.ts) { best = m[tid]; bestTid = tid; }
      }
      if (best) return { tid: bestTid, vid: best.vid, vh: best.vh, goals: best.goals || [] };
    } catch(e) {}
    return null;
  }

  function cleanUrl(keys) {
    try {
      var params = new URLSearchParams(window.location.search);
      var changed = false;
      keys.forEach(function(k) { if (params.has(k)) { params.delete(k); changed = true; } });
      if (changed) {
        var qs = params.toString();
        var clean = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
        history.replaceState(null, "", clean);
      }
    } catch(e) {}
  }

  // ─── Scan mode ─────────────────────────────────────────────────────────────

  var _scanBanner = null;
  var _scanVid = null;
  var _scanStepCount = 0;
  var _scanObserver = null;
  // Tracks element keys already POSTed this session (type|id|text) — mirrors API dedup key
  var _scannedKeys = {};

  var BANNER_BASE_STYLE = [
    'position:fixed','bottom:20px','right:20px','z-index:2147483647',
    'background:#16a34a','color:#fff',
    'padding:12px 16px','border-radius:10px',
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
    'font-size:13px','font-weight:600','letter-spacing:0.01em',
    'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
    'display:flex','flex-direction:column','gap:8px','max-width:340px'
  ].join(';');

  var BANNER_RED_STYLE = BANNER_BASE_STYLE.replace('background:#16a34a','background:#dc2626');

  function mountBanner(style) {
    if (_scanBanner) { _scanBanner.setAttribute('style', style); return; }
    _scanBanner = document.createElement('div');
    _scanBanner.setAttribute('style', style);
    // Delegate finish-scan clicks on the banner element itself — survives innerHTML replacements
    _scanBanner.addEventListener('click', function(e) {
      var t = e.target;
      if (t && (t.id === 'sl-finish-scan' || (t.parentElement && t.parentElement.id === 'sl-finish-scan'))) {
        finishScan();
      }
    });
    if (document.body) {
      document.body.appendChild(_scanBanner);
    } else {
      document.addEventListener('DOMContentLoaded', function() { document.body.appendChild(_scanBanner); });
    }
  }

  function renderBanner(stepCount, warningMsg) {
    var stepLine = stepCount > 1
      ? '<div style="font-size:12px;font-weight:400;opacity:0.85">Step ' + stepCount + ' detected — continue through remaining steps</div>'
      : '<div style="font-size:12px;font-weight:400;opacity:0.85">If this form has multiple steps, navigate through each step in order to scan all fields</div>';
    var warnLine = warningMsg
      ? '<div style="font-size:12px;font-weight:400;color:#fca5a5">' + warningMsg + '</div>'
      : '';
    var btn = '<button id="sl-finish-scan" style="margin-top:4px;background:#fff;color:#16a34a;border:none;border-radius:6px;padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer;align-self:flex-start">Finish Scanning</button>';
    _scanBanner.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:15px">✦</span><span>Scanning your page...</span></div>' +
      stepLine + warnLine + btn;
  }

  function finishScan() {
    if (_scanObserver) { _scanObserver.disconnect(); _scanObserver = null; }
    _scanBanner.setAttribute('style', BANNER_BASE_STYLE);
    _scanBanner.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:15px">✓</span><span>Scan complete — you can close this tab</span></div>';
    // window.close() only works when tab was opened by script; hide banner as fallback
    setTimeout(function() {
      try { window.close(); } catch(e) {}
    }, 3000);
  }

  function showScanBanner() {
    mountBanner(BANNER_BASE_STYLE);
    renderBanner(1, null);
  }

  function completeScanBanner() {
    // Initial scan succeeded — show persistent banner with disclaimer + Finish Scanning button
    mountBanner(BANNER_BASE_STYLE);
    renderBanner(_scanStepCount || 1, null);
  }

  function stepScanBanner(warningMsg) {
    if (_scanBanner) renderBanner(_scanStepCount, warningMsg || null);
  }

  function failScanBanner() {
    mountBanner(BANNER_RED_STYLE);
    _scanBanner.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:15px">✕</span><span>Could not detect events on this page</span></div>';
    setTimeout(function() {
      window.close();
      setTimeout(function() {
        if (_scanBanner) _scanBanner.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:15px">✕</span><span>Could not detect events — you can close this tab</span></div>';
      }, 100);
    }, 5000);
  }

  function inBanner(el) {
    return !!(_scanBanner && _scanBanner.contains(el));
  }

  function cleanText(value) {
    return (value || "").replace(/\\s+/g, " ").trim();
  }

  function fieldKey(field) {
    var tag = (field.tagName || "").toLowerCase();
    var type = (field.type || "").toLowerCase();
    if (type === "password" || type === "hidden" || type === "submit" || type === "button" || type === "reset" || type === "file") return null;
    var key = cleanText(field.name || field.id || field.getAttribute("placeholder") || field.getAttribute("aria-label") || type || tag);
    return key ? encodeURIComponent(key.toLowerCase().slice(0, 80)) : null;
  }

  function formFieldSignature(form) {
    var seen = {};
    var fields = [];
    if (!form || !form.querySelectorAll) return null;
    var inputs = form.querySelectorAll("input, select, textarea");
    for (var fi = 0; fi < inputs.length; fi++) {
      var key = fieldKey(inputs[fi]);
      if (!key || seen[key]) continue;
      seen[key] = true;
      fields.push(key);
    }
    if (!fields.length) return null;
    // Sort so field order in the DOM doesn't change the signature
    fields.sort();
    // Cap so "fields:" selectors stay within API limits; the same cap applies
    // at scan time and submit time, so capped signatures still compare equal
    var sig = fields.join("|");
    return sig.length > 300 ? sig.slice(0, 300) : sig;
  }

  function formSubmitText(form) {
    if (!form || !form.querySelector) return null;
    var submit = form.querySelector("button[type='submit'], input[type='submit'], button:not([type]), [role='button']");
    return submit ? cleanText(submit.textContent || submit.value || submit.getAttribute("aria-label")).slice(0, 100) : null;
  }

  function incrementCount(counts, key) {
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
  }

  // Read id/name via getAttribute: named inputs (e.g. <input name="id">) shadow
  // form.id / form.name with the element itself instead of the attribute string.
  // Capped identically at scan time and submit time so selectors compare equal.
  function formId(form) {
    if (!form || !form.getAttribute) return null;
    return (form.getAttribute("id") || "").slice(0, 255) || null;
  }

  function formName(form) {
    if (!form || !form.getAttribute) return null;
    return (form.getAttribute("name") || "").slice(0, 150) || null;
  }

  function collectFormSelectorCounts(forms) {
    var counts = {};
    for (var ci = 0; ci < forms.length; ci++) {
      var form = forms[ci];
      var name = formName(form);
      incrementCount(counts, name ? "name:" + name : null);
      var submitText = formSubmitText(form);
      incrementCount(counts, submitText ? "text:" + submitText.toLowerCase() : null);
      var fields = formFieldSignature(form);
      incrementCount(counts, fields ? "fields:" + fields : null);
    }
    return counts;
  }

  // Selector priority: content-based identity (id/name/submit text/fields) first,
  // DOM position (nth:) strictly last. Position breaks silently when the DOM changes:
  // injected popup/chat-widget forms shift the index, SPA mount order varies, and
  // page edits renumber every form. Content survives reordering; position does not.
  function formSelector(form, counts) {
    var fid = formId(form);
    if (fid) return "id:" + fid;
    var name = formName(form);
    if (name && (!counts || counts["name:" + name] === 1)) return "name:" + name;
    var submitText = formSubmitText(form);
    if (submitText && (!counts || counts["text:" + submitText.toLowerCase()] === 1)) return "text:" + submitText;
    var fields = formFieldSignature(form);
    if (fields && (!counts || counts["fields:" + fields] === 1)) return "fields:" + fields;
    var idx = formDocumentIndex(form);
    return idx >= 0 ? "nth:" + idx : null;
  }

  function formDocumentIndex(form) {
    try {
      return Array.prototype.indexOf.call(document.querySelectorAll("form"), form);
    } catch(e) { return -1; }
  }

  // Display label = form identity, NOT submit-button text (that confuses forms with buttons).
  // Priority mirrors the selector: id → name → fields → nth → submit text last.
  function formLabel(form, selector) {
    var fid = formId(form);
    if (fid) return ("#" + fid).slice(0, 100);
    var name = formName(form);
    if (name) return name.slice(0, 100);
    if (selector && selector.indexOf("fields:") === 0) {
      return selector.slice(7).split("|").map(decodeURIComponent).join(", ").slice(0, 100) || null;
    }
    if (selector && selector.indexOf("nth:") === 0) {
      var n = parseInt(selector.slice(4), 10);
      return !isNaN(n) ? "Form #" + (n + 1) : "Form";
    }
    var submitText = formSubmitText(form);
    return submitText ? ("Form (“" + submitText + "”)").slice(0, 100) : "Form";
  }

  function buttonVisibleText(btn) {
    return cleanText(btn.textContent || btn.value || "").slice(0, 100) || null;
  }

  // Buttons: id → visible text → unique name → aria-label (as text:).
  // No nth: pages have dozens of buttons; chat/cookie widgets inject more and
  // shift indexes constantly, so position is too fragile to be useful.
  function buttonSelector(btn, nameCounts) {
    var bid = (btn.getAttribute("id") || "").slice(0, 255) || null;
    if (bid) return "id:" + bid;
    var text = buttonVisibleText(btn);
    if (text) return "text:" + text;
    var name = (btn.getAttribute("name") || "").slice(0, 150) || null;
    if (name && (!nameCounts || nameCounts[name] === 1)) return "name:" + name;
    var aria = cleanText(btn.getAttribute("aria-label")).slice(0, 100) || null;
    if (aria) return "text:" + aria;
    return null;
  }

  function buttonLabel(btn, selector) {
    var bid = (btn.getAttribute("id") || "").slice(0, 255) || null;
    if (bid) return ("#" + bid).slice(0, 100);
    var text = buttonVisibleText(btn);
    if (text) return text;
    if (selector && selector.indexOf("name:") === 0) return selector.slice(5);
    if (selector && selector.indexOf("text:") === 0) return selector.slice(5);
    return "Button";
  }

  function toggleAssociatedLabel(cb) {
    var aria = cleanText(cb.getAttribute("aria-label"));
    if (aria) return aria.slice(0, 100);
    var name = (cb.getAttribute("name") || "").slice(0, 150) || null;
    if (name) return name;
    var cid = (cb.getAttribute("id") || "") || null;
    if (cid) {
      var labels = document.querySelectorAll("label[for]");
      for (var li = 0; li < labels.length; li++) {
        if (labels[li].htmlFor === cid) {
          var t = cleanText(labels[li].textContent).slice(0, 100);
          if (t) return t;
        }
      }
    }
    var parent = cb.closest ? cb.closest("label") : null;
    if (parent) {
      var pt = cleanText(parent.textContent).slice(0, 100);
      if (pt) return pt;
    }
    return null;
  }

  // Toggles: id → aria-label (text:) → name (name:) → associated <label> text.
  // No nth — same reason as buttons.
  function toggleSelector(cb) {
    var cid = (cb.getAttribute("id") || "").slice(0, 255) || null;
    if (cid) return "id:" + cid;
    var aria = cleanText(cb.getAttribute("aria-label")).slice(0, 100) || null;
    if (aria) return "text:" + aria;
    var name = (cb.getAttribute("name") || "").slice(0, 150) || null;
    if (name) return "name:" + name;
    var label = toggleAssociatedLabel(cb);
    return label ? "text:" + label : null;
  }

  function toggleLabel(cb, selector) {
    var cid = (cb.getAttribute("id") || "").slice(0, 255) || null;
    if (cid) return ("#" + cid).slice(0, 100);
    if (selector && selector.indexOf("name:") === 0) return selector.slice(5);
    if (selector && selector.indexOf("text:") === 0) return selector.slice(5);
    return toggleAssociatedLabel(cb) || "Toggle";
  }

  function collectElements() {
    var elements = [];

    var forms = document.querySelectorAll("form");
    var formCounts = collectFormSelectorCounts(forms);
    for (var i = 0; i < forms.length; i++) {
      if (inBanner(forms[i])) continue;
      var selector = formSelector(forms[i], formCounts);
      elements.push({ type: "form", id: formId(forms[i]), text: formLabel(forms[i], selector), selector: selector });
    }

    var buttons = document.querySelectorAll("button, [role='button'], [role='switch'], input[type='submit'], input[type='button']");
    var buttonNameCounts = {};
    for (var bj = 0; bj < buttons.length; bj++) {
      if (inBanner(buttons[bj])) continue;
      var bn = (buttons[bj].getAttribute("name") || "").slice(0, 150) || null;
      if (bn) buttonNameCounts[bn] = (buttonNameCounts[bn] || 0) + 1;
    }
    for (var j = 0; j < buttons.length; j++) {
      var btn = buttons[j];
      if (inBanner(btn)) continue;
      var bSel = buttonSelector(btn, buttonNameCounts);
      elements.push({
        type: "button",
        id: (btn.getAttribute("id") || "").slice(0, 255) || null,
        text: buttonLabel(btn, bSel),
        selector: bSel
      });
    }

    var checkboxes = document.querySelectorAll("input[type='checkbox']");
    for (var m = 0; m < checkboxes.length; m++) {
      var cb = checkboxes[m];
      if (inBanner(cb)) continue;
      var tSel = toggleSelector(cb);
      elements.push({
        type: "toggle",
        id: (cb.getAttribute("id") || "").slice(0, 255) || null,
        text: toggleLabel(cb, tSel),
        selector: tSel
      });
    }

    var links = document.querySelectorAll("a");
    for (var k = 0; k < links.length; k++) {
      var link = links[k];
      if (inBanner(link)) continue;
      var href = link.getAttribute("href") || "";
      if (!href || href.charAt(0) === "#" || href.indexOf("javascript:") === 0) continue;
      var ltype = href.indexOf("tel:") === 0 ? "call" : "link";
      elements.push({
        type: ltype,
        id: link.id || null,
        text: (link.textContent || href).trim().slice(0, 100) || null
      });
    }

    return elements;
  }

  function postScanElements(vid, elements, onSuccess, onError) {
    var payload = JSON.stringify({ vid: vid, elements: elements });
    var xhr = new XMLHttpRequest();
    xhr.open("POST", SCAN_URL, true);
    xhr.withCredentials = false;
    xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
    xhr.onload = function() {
      if (xhr.status >= 200 && xhr.status < 300) onSuccess();
      else onError();
    };
    xhr.onerror = onError;
    xhr.send(payload);
  }

  function runScan(vid) {
    _scanVid = vid;
    _scanStepCount = 1;

    var elements = collectElements();
    // Mark all as seen
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      _scannedKeys[el.type + "|" + (el.id || "") + "|" + (el.text || "") + "|" + (el.selector || "")] = true;
    }

    try {
      showScanBanner();
      postScanElements(vid, elements, function() {
        completeScanBanner();
        startStepperObserver(vid);
      }, function() {
        failScanBanner();
      });
    } catch(e) { failScanBanner(); }
  }

  function startStepperObserver(vid) {
    if (!window.MutationObserver) return;
    var debounceTimer = null;

    _scanObserver = new MutationObserver(function(mutations) {
      // Check if any added node contains a form-relevant element
      var hasRelevant = false;
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          var tag = node.tagName ? node.tagName.toLowerCase() : "";
          if (tag === "form" || tag === "input" || tag === "button" || tag === "select" || tag === "textarea") {
            hasRelevant = true; break;
          }
          if (node.querySelector && node.querySelector("form,input,button,select,textarea")) {
            hasRelevant = true; break;
          }
        }
        if (hasRelevant) break;
      }
      if (!hasRelevant) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function() {
        // Diff: collect only elements not yet POSTed
        var all = collectElements();
        var newEls = [];
        for (var n = 0; n < all.length; n++) {
          var e = all[n];
          var key = e.type + "|" + (e.id || "") + "|" + (e.text || "") + "|" + (e.selector || "");
          if (!_scannedKeys[key]) {
            _scannedKeys[key] = true;
            newEls.push(e);
          }
        }
        if (newEls.length === 0) return;

        _scanStepCount++;
        stepScanBanner(null);

        postScanElements(vid, newEls, function() {
          stepScanBanner(null);
        }, function() {
          stepScanBanner("Step " + _scanStepCount + " failed to save — navigate back to that step and try again");
        });
      }, 800);
    });

    _scanObserver.observe(document.body, { childList: true, subtree: true });

    // Also trigger on button clicks — catches CSS-toggle steppers where no DOM nodes
    // are added (MutationObserver childList won't fire in that case)
    var clickRescanTimer = null;
    document.addEventListener('click', function(e) {
      var t = e.target;
      if (!t || inBanner(t)) return;
      var isBtn = t.closest
        ? t.closest("button, [role='button'], input[type='submit'], input[type='button']")
        : (t.tagName === 'BUTTON' || t.tagName === 'INPUT');
      if (!isBtn) return;
      clearTimeout(clickRescanTimer);
      clickRescanTimer = setTimeout(function() {
        var all = collectElements();
        var newEls = [];
        for (var n = 0; n < all.length; n++) {
          var e2 = all[n];
          var key = e2.type + "|" + (e2.id || "") + "|" + (e2.text || "") + "|" + (e2.selector || "");
          if (!_scannedKeys[key]) {
            _scannedKeys[key] = true;
            newEls.push(e2);
          }
        }
        if (newEls.length === 0) return;
        _scanStepCount++;
        stepScanBanner(null);
        postScanElements(vid, newEls, function() {
          stepScanBanner(null);
        }, function() {
          stepScanBanner("Step " + _scanStepCount + " failed to save — navigate back to that step and try again");
        });
      }, 1000);
    }, true);
  }

  // ─── Core tracking ─────────────────────────────────────────────────────────

  function track(type, goalId, meta) {
    if (!_ctx) return;
    var key = type + ":" + (goalId || "") + ":" + (meta && meta.trigger || "") + ":" + (meta && meta.id || "") + ":" + (meta && meta.text || "");
    if (_sent[key]) return;
    _sent[key] = true;

    var payload = {
      testId: _ctx.tid,
      variantId: _ctx.vid,
      visitorHash: _ctx.vh,
      type: type,
      goalId: goalId || null
    };
    if (meta) payload.metadata = meta;
    send(payload);
  }

  // ─── Form lead capture ──────────────────────────────────────────────────────

  // Accumulates form field values across stepper steps so submit captures all steps' data
  var _accumulatedFormData = {};

  function snapshotVisibleFormFields() {
    try {
      var inputs = document.querySelectorAll("input, select, textarea");
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        var t = (el.type || "").toLowerCase();
        if (t === "password" || t === "hidden" || t === "submit" || t === "button" || t === "reset" || t === "file") continue;
        if ((t === "checkbox" || t === "radio") && !el.checked) continue;
        var key = el.name || el.id || el.getAttribute("placeholder") || null;
        if (key && el.value) _accumulatedFormData[key] = el.value;
      }
    } catch(e) {}
  }

  function captureFormLead(form) {
    if (!_ctx) return;
    try {
      // Start with accumulated data from previous steps, then overlay current DOM fields
      var fields = {};
      var k;
      for (k in _accumulatedFormData) { if (_accumulatedFormData.hasOwnProperty(k)) fields[k] = _accumulatedFormData[k]; }
      var elements = form.elements;
      for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        var t = (el.type || "").toLowerCase();
        if (t === "password" || t === "hidden" || t === "submit" || t === "button" || t === "reset" || t === "file") continue;
        if ((t === "checkbox" || t === "radio") && !el.checked) continue;
        var fkey = el.name || el.id || el.getAttribute("placeholder") || null;
        if (fkey) fields[fkey] = el.value || "";
      }
      var sp = new URLSearchParams(window.location.search);
      var utm = {};
      ["utm_source","utm_medium","utm_content","utm_term","utm_campaign","gclid","fbclid"].forEach(function(k) {
        if (sp.get(k)) utm[k] = sp.get(k);
      });
      var payload = JSON.stringify({
        testId: _ctx.tid,
        variantId: _ctx.vid,
        visitorHash: _ctx.vh,
        formFields: fields,
        utm: utm
      });
      var FORM_LEADS_URL = API_BASE + "/api/form-leads";
      if (navigator.sendBeacon) {
        try {
          var blob = new Blob([payload], { type: "text/plain" });
          if (navigator.sendBeacon(FORM_LEADS_URL, blob)) return;
        } catch(e) {}
      }
      var xhr = new XMLHttpRequest();
      xhr.open("POST", FORM_LEADS_URL, true);
      xhr.withCredentials = false;
      xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
      xhr.send(payload);
    } catch(e) {}
  }

  // ─── JS-submit capture (divs with inputs, no <form> tag) ───────────────────

  var _leadSent = false; // deduplicate — only send once per page session

  function captureFormLeadFromAccumulated() {
    if (!_ctx || _leadSent) return;
    var hasData = false;
    for (var k in _accumulatedFormData) {
      if (_accumulatedFormData.hasOwnProperty(k) && _accumulatedFormData[k]) { hasData = true; break; }
    }
    if (!hasData) return;
    _leadSent = true;

    var sp = new URLSearchParams(window.location.search);
    var utm = {};
    ["utm_source","utm_medium","utm_content","utm_term","utm_campaign","gclid","fbclid"].forEach(function(key) {
      if (sp.get(key)) utm[key] = sp.get(key);
    });
    var payload = JSON.stringify({
      testId: _ctx.tid,
      variantId: _ctx.vid,
      visitorHash: _ctx.vh,
      formFields: _accumulatedFormData,
      utm: utm
    });
    var FORM_LEADS_URL = API_BASE + "/api/form-leads";
    try {
      var blob = new Blob([payload], { type: "text/plain" });
      if (navigator.sendBeacon && navigator.sendBeacon(FORM_LEADS_URL, blob)) return;
    } catch(e) {}
    var xhr2 = new XMLHttpRequest();
    xhr2.open("POST", FORM_LEADS_URL, true);
    xhr2.withCredentials = false;
    xhr2.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
    xhr2.send(payload);
  }

  function patchNetworkForJsSubmit() {
    if (!_ctx) return;
    try {
      // Patch XMLHttpRequest
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this._sl_method = method;
        this._sl_url = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        var method = (this._sl_method || "").toUpperCase();
        var url = this._sl_url || "";
        // Only intercept POST requests that are NOT going to our own API
        if (method === "POST" && url.indexOf(API_BASE) !== 0 && url.indexOf("/api/") !== 0) {
          captureFormLeadFromAccumulated();
        }
        return origSend.apply(this, arguments);
      };

      // Patch fetch
      var origFetch = window.fetch;
      window.fetch = function(input, init) {
        try {
          var method = (init && init.method || "GET").toUpperCase();
          var url = (typeof input === "string" ? input : (input && input.url)) || "";
          if (method === "POST" && url.indexOf(API_BASE) !== 0 && url.indexOf("/api/") !== 0) {
            captureFormLeadFromAccumulated();
          }
        } catch(e) {}
        return origFetch.apply(this, arguments);
      };
    } catch(e) {}
  }

  // ─── Register form field names (for HubSpot mapping UI) ────────────────────

  var _registeredFields = {}; // module-scope: persists across stepper re-runs
  var _fieldObserver = null;

  function registerFormFields() {
    if (!_ctx) return;
    try {
      var fields = [];
      var inputs = document.querySelectorAll("input[name], select[name], textarea[name]");
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        var name = el.name;
        if (!name || _registeredFields[name]) continue;
        var t = (el.type || "").toLowerCase();
        if (t === "password" || t === "hidden" || t === "submit" || t === "button" || t === "reset" || t === "file") continue;
        _registeredFields[name] = true;
        fields.push(name);
      }
      if (fields.length === 0) return;
      var xhr = new XMLHttpRequest();
      xhr.open("POST", REGISTER_FIELDS_URL, true);
      xhr.withCredentials = false;
      xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
      xhr.send(JSON.stringify({ variantId: _ctx.vid, fields: fields }));
    } catch(e) {}
  }

  function watchForNewFields() {
    if (!window.MutationObserver || _fieldObserver) return;
    var debounce = null;
    _fieldObserver = new MutationObserver(function(mutations) {
      var hasInput = false;
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          var tag = node.tagName ? node.tagName.toLowerCase() : "";
          if (tag === "input" || tag === "select" || tag === "textarea") { hasInput = true; break; }
          if (node.querySelector && node.querySelector("input[name],select[name],textarea[name]")) { hasInput = true; break; }
        }
        if (hasInput) break;
      }
      if (!hasInput) return;
      clearTimeout(debounce);
      debounce = setTimeout(registerFormFields, 800);
    });
    _fieldObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Auto-wire conversions (zero config) ────────────────────────────────────

  function wireAutoConversions() {
    // Use event delegation so dynamically-rendered elements (React/SPA) are tracked
    document.addEventListener("change", function(e) {
      var el = e.target;
      if (el && el.tagName === "INPUT" && el.type === "checkbox") {
        track("conversion", null, {
          trigger: "button_click",
          id: (el.getAttribute("id") || null),
          name: (el.getAttribute("name") || null),
          text: toggleAssociatedLabel(el)
        });
      }
    }, true);

    document.addEventListener("submit", function(e) {
      var form = e.target;
      _leadSent = true; // prevent JS-submit patch from double-sending
      captureFormLead(form);
      var formNth = form ? formDocumentIndex(form) : -1;
      track("conversion", null, {
        trigger: "form_submit",
        id: formId(form),
        name: formName(form),
        text: formSubmitText(form),
        fields: formFieldSignature(form),
        nth: formNth >= 0 ? formNth : null
      });
    }, true);

    document.addEventListener("click", function(e) {
      var el = e.target;
      if (!el || !el.closest) return;

      // Check for tel: link clicks (call conversions)
      var link = el.closest("a[href^='tel:']");
      if (link) {
        track("conversion", null, { trigger: "call_click", id: link.id || null, text: (link.textContent || "").trim().slice(0, 50) || null });
        return;
      }

      // Check for button / switch clicks
      var btn = el.closest("button, [role='button'], [role='switch'], input[type='submit'], input[type='button']");
      if (btn) {
        // Snapshot form values before potential step transition removes current fields
        snapshotVisibleFormFields();
        var btnText = buttonVisibleText(btn) || cleanText(btn.getAttribute("aria-label"));
        // If button text looks like a final submit and we have accumulated data,
        // send lead immediately — covers onclick-only forms with no network request
        if (!_leadSent) {
          var submitWords = /^(submit|send|get|book|schedule|contact|request|apply|sign up|register|subscribe|confirm|continue|finish|complete|done|go|start|claim|unlock|download|access)/i;
          if (submitWords.test(btnText || "")) {
            setTimeout(function() {
              // Small delay so any sync handleSubmit logic runs first
              // If fetch patch already sent it, _leadSent will be true — skip
              captureFormLeadFromAccumulated();
            }, 100);
          }
        }
        track("conversion", null, {
          trigger: "button_click",
          text: (btnText || "").slice(0, 100) || null,
          id: (btn.getAttribute("id") || null),
          name: (btn.getAttribute("name") || "").slice(0, 150) || null
        });
        return;
      }

      // Check for link clicks
      var cta = el.closest("a");
      if (cta) {
        var href = cta.getAttribute("href") || "";
        if (!href || href.charAt(0) === "#" || href.indexOf("javascript:") === 0) return;
        track("conversion", null, { trigger: "button_click", text: (cta.textContent || "").trim().slice(0, 50), id: cta.id || null });
      }
    }, true);
  }

  // ─── URL goal checking ───────────────────────────────────────────────────────

  function checkUrlGoals() {
    if (!_ctx || !_ctx.goals || !_ctx.goals.length) return;
    var url = window.location.href;
    var pathname = window.location.pathname + window.location.search;
    _ctx.goals.forEach(function(goal) {
      if (goal.type !== "url_reached" || !goal.urlPattern) return;
      try {
        var pattern = new RegExp(goal.urlPattern, "i");
        if (pattern.test(url) || pattern.test(pathname)) {
          track("conversion", goal.id);
        }
      } catch(e) {}
    });
  }

  // Fire OTHER tests' saved url_reached goals from the per-test map, each
  // attributed to the variant/visitor stored when that test was seen. The
  // current test's own goals are handled by checkUrlGoals(). Dedup is
  // in-memory per page-load only (like _sent) so raw goal-hit counts in
  // analytics are unchanged.
  var _sentStored = {};
  function checkStoredUrlGoals() {
    if (_scanMode) return;
    var m = loadMap();
    var url = window.location.href;
    var pathname = window.location.pathname + window.location.search;
    var currentTid = _ctx && _ctx.tid;
    for (var tid in m) {
      if (tid === currentTid) continue;
      var entry = m[tid];
      (entry.goals || []).forEach(function(goal) {
        if (goal.type !== "url_reached" || !goal.urlPattern) return;
        if (_sentStored[goal.id]) return;
        try {
          var pattern = new RegExp(goal.urlPattern, "i");
          if (pattern.test(url) || pattern.test(pathname)) {
            _sentStored[goal.id] = true;
            send({
              testId: tid,
              variantId: entry.vid,
              visitorHash: entry.vh,
              type: "conversion",
              goalId: goal.id
            });
          }
        } catch(e) {}
      });
    }
  }

  function wireUrlGoals() {
    function checkAllUrlGoals() {
      checkUrlGoals();
      checkStoredUrlGoals();
    }
    checkAllUrlGoals();
    function wrapHistory(method) {
      var orig = history[method];
      history[method] = function() { orig.apply(this, arguments); checkAllUrlGoals(); };
    }
    try { wrapHistory("pushState"); wrapHistory("replaceState"); } catch(e) {}
    window.addEventListener("popstate", function() { checkAllUrlGoals(); });
    window.addEventListener("hashchange", function() { checkAllUrlGoals(); });
  }

  // ─── Detection: resolve context from URL params or localStorage ────────────

  function detect(callback) {
    var params = new URLSearchParams(window.location.search);
    var isScan = params.get("sl_scan") === "1";
    _scanMode = isScan;

    // Method 1: Full params from SplitLab redirect (?sl_tid, ?sl_vid, ?sl_vh)
    var tid = params.get("sl_tid");
    var vid = params.get("sl_vid");
    var vh  = params.get("sl_vh");
    if (tid && vid && vh) {
      cleanUrl(["sl_tid", "sl_vid", "sl_vh", "sl_scan"]);
      return callback({ tid: tid, vid: vid, vh: vh, goals: [] });
    }

    // Method 2: Variant ID only (?sl_vid=xxx) — resolve test ID + goals via API
    if (vid && !tid) {
      cleanUrl(["sl_vid", "sl_scan"]);
      if (isScan) showScanBanner();
      var tempVh = vh || uuid();
      var xhr = new XMLHttpRequest();
      xhr.open("GET", RESOLVE_URL + "?vid=" + encodeURIComponent(vid), true);
      xhr.withCredentials = false;
      xhr.onload = function() {
        try {
          var data = JSON.parse(xhr.responseText);
          if (data.testId) {
            var ctx = { tid: data.testId, vid: data.variantId, vh: tempVh, goals: data.goals || [] };
            store(ctx);
            if (isScan) {
              if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", function() { runScan(vid); });
              } else {
                runScan(vid);
              }
            }
            callback(ctx);
          } else {
            if (isScan) failScanBanner();
            callback(load());
          }
        } catch(e) {
          if (isScan) failScanBanner();
          callback(load());
        }
      };
      xhr.onerror = function() {
        if (isScan) failScanBanner();
        callback(load());
      };
      xhr.send();
      return;
    }

    // Method 3: Shorthand (?sl_variant=xxx)
    var variantId = params.get("sl_variant");
    if (variantId) {
      cleanUrl(["sl_variant", "sl_scan"]);
      var xhr2 = new XMLHttpRequest();
      xhr2.open("GET", RESOLVE_URL + "?vid=" + encodeURIComponent(variantId), true);
      xhr2.withCredentials = false;
      xhr2.onload = function() {
        try {
          var data = JSON.parse(xhr2.responseText);
          if (data.testId) {
            var ctx = { tid: data.testId, vid: data.variantId, vh: uuid(), goals: data.goals || [] };
            store(ctx);
            callback(ctx);
          } else {
            callback(load());
          }
        } catch(e) { callback(load()); }
      };
      xhr2.onerror = function() { callback(load()); };
      xhr2.send();
      return;
    }

    // Method 4: localStorage (returning visitor)
    callback(load());
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────

  function boot(ctx) {
    _ctx = ctx;
    if (!_ctx) return;
    store(_ctx);

    function start() {
      // SplitLab-served pages get an inline snippet injected at body end that
      // does everything this script does. If it's present, stand down entirely
      // (all capture paths no-op once _ctx is null) or leads/pageviews double.
      // Checked at DOM-ready because the snippet runs after a hardcoded
      // tracker.js tag placed earlier in the body.
      if (window.__SL_SNIPPET__) {
        _ctx = null;
        return;
      }
      track("pageview");
      wireUrlGoals();
      wireAutoConversions();
      registerFormFields();
      watchForNewFields();
      patchNetworkForJsSubmit();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }

  // ─── Public API (optional manual use) ───────────────────────────────────────

  window.SplitLab = {
    track: function(type, goalId, meta) {
      track(type || "conversion", goalId, meta);
    },
    getContext: function() { return _ctx; },
    isActive: function() { return !!_ctx; }
  };

  // Auto-detect and boot — no init() call needed
  detect(boot);

})();
`;
}
