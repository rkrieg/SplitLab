COMMITS:
//THIS WAS FOR WINDOW.location.href dk check it
/src/app/tracker.js -> route.ts

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

  function store(ctx) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ctx)); } catch(e) {}
  }

  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (d && d.tid && d.vid && d.vh) return d;
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

  // ─── Cross-domain linker (like GA4's _gl) ───────────────────────────────────
  // localStorage never crosses origins, so the only way context survives a jump
  // to another domain is in the URL itself. Decorate outbound cross-domain
  // navigations with sl_tid/sl_vid/sl_vh; detect() Method 1 rebuilds context on
  // the destination and cleanUrl() strips the params there.

  function decorate(url) {
    try {
      if (!_ctx || !url) return url;
      var u = new URL(String(url), window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return url;
      if (u.hostname === window.location.hostname) return url;
      if (u.searchParams.get("sl_vid") || u.searchParams.get("sl_tid")) return url;
      u.searchParams.set("sl_tid", _ctx.tid);
      u.searchParams.set("sl_vid", _ctx.vid);
      u.searchParams.set("sl_vh", _ctx.vh);
      return u.toString();
    } catch(e) { return url; }
  }

  function decorateLink(a) {
    try {
      var dec = decorate(a.href);
      if (dec !== a.href) a.href = dec;
    } catch(e) {}
  }

  function patchWindowOpen() {
    try {
      var origOpen = window.open;
      if (!origOpen || origOpen.__sl_patched) return;
      var patched = function() {
        var args = Array.prototype.slice.call(arguments);
        if (args[0]) args[0] = decorate(String(args[0]));
        return origOpen.apply(window, args);
      };
      patched.__sl_patched = true;
      window.open = patched;
    } catch(e) {}
  }

  function watchNavigations() {
    // Navigation API (Baseline 2026): the only hook that sees JS redirects
    // (window.location.href = ...). Cancel undecorated cross-domain jumps and
    // re-issue them decorated. Older browsers skip this and keep today's
    // behavior; links/forms are already decorated earlier so they pass through.
    try {
      if (!window.navigation || !window.navigation.addEventListener) return;
      window.navigation.addEventListener("navigate", function(e) {
        try {
          if (!e.cancelable || e.formData || e.downloadRequest) return;
          if (e.navigationType !== "push" && e.navigationType !== "replace") return;
          var dest = e.destination && e.destination.url;
          var dec = decorate(dest);
          if (!dest || dec === dest) return;
          e.preventDefault();
          window.location.href = dec;
        } catch(err) {}
      });
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
      // Read action via getAttribute — an input named "action" shadows form.action
      if (form && form.getAttribute) {
        var slAction = form.getAttribute("action");
        if (slAction) {
          var decAction = decorate(slAction);
          if (decAction !== slAction) {
            var slMethod = (form.getAttribute("method") || "get").toLowerCase();
            if (slMethod === "get") {
              // GET submits replace the action's query string with the form
              // fields, so carry the params as hidden inputs instead
              ["sl_tid", "sl_vid", "sl_vh"].forEach(function(name) {
                if (form.querySelector && form.querySelector("input[name='" + name + "']")) return;
                var hidden = document.createElement("input");
                hidden.type = "hidden";
                hidden.name = name;
                hidden.value = name === "sl_tid" ? _ctx.tid : name === "sl_vid" ? _ctx.vid : _ctx.vh;
                form.appendChild(hidden);
              });
            } else {
              form.setAttribute("action", decAction);
            }
          }
        }
      }
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

    // Decorate cross-domain links before the browser follows them. mousedown
    // precedes every click variant, and middle-click fires auxclick (not click)
    // in some browsers — cover all three so new-tab opens are decorated too.
    function decorateFromEvent(e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var a = t.closest("a[href]");
      if (a) decorateLink(a);
    }
    document.addEventListener("mousedown", decorateFromEvent, true);
    document.addEventListener("auxclick", decorateFromEvent, true);

    document.addEventListener("click", function(e) {
      var el = e.target;
      if (!el || !el.closest) return;
      decorateFromEvent(e);

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

  function wireUrlGoals() {
    if (!_ctx || !_ctx.goals || !_ctx.goals.length) return;
    checkUrlGoals();
    function wrapHistory(method) {
      var orig = history[method];
      history[method] = function() { orig.apply(this, arguments); checkUrlGoals(); };
    }
    try { wrapHistory("pushState"); wrapHistory("replaceState"); } catch(e) {}
    window.addEventListener("popstate", function() { checkUrlGoals(); });
    window.addEventListener("hashchange", function() { checkUrlGoals(); });
  }

  // ─── Detection: resolve context from URL params or localStorage ────────────

  function detect(callback) {
    var params = new URLSearchParams(window.location.search);
    var isScan = params.get("sl_scan") === "1";

    // Method 1: Full params from SplitLab redirect (?sl_tid, ?sl_vid, ?sl_vh)
    var tid = params.get("sl_tid");
    var vid = params.get("sl_vid");
    var vh  = params.get("sl_vh");
    if (tid && vid && vh) {
      cleanUrl(["sl_tid", "sl_vid", "sl_vh", "sl_scan"]);
      // Fetch goals so url_reached patterns can fire on this page too (params
      // may arrive via cross-domain link decoration, not just a SplitLab 302)
      var xhr0 = new XMLHttpRequest();
      xhr0.open("GET", RESOLVE_URL + "?vid=" + encodeURIComponent(vid), true);
      xhr0.withCredentials = false;
      xhr0.onload = function() {
        var goals = [];
        try {
          var data = JSON.parse(xhr0.responseText);
          if (data.goals) goals = data.goals;
        } catch(e) {}
        callback({ tid: tid, vid: vid, vh: vh, goals: goals });
      };
      xhr0.onerror = function() {
        callback({ tid: tid, vid: vid, vh: vh, goals: [] });
      };
      xhr0.send();
      return;
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
      patchWindowOpen();
      watchNavigations();
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
    isActive: function() { return !!_ctx; },
    // Manual escape hatch for JS-driven cross-domain redirects in browsers
    // without the Navigation API: SplitLab.go(url) instead of location.href = url
    decorate: function(url) { return decorate(url); },
    go: function(url) { window.location.href = decorate(url); }
  };

  // Auto-detect and boot — no init() call needed
  detect(boot);

})();
`;
}

/src/lib/tracking.ts
import type { ConversionGoal } from '@/types';

/**
 * Generate the lightweight tracking snippet injected into every served page.
 * This snippet fires a pageview event immediately and wires up conversion
 * goal listeners based on the test configuration.
 */
export function buildTrackingSnippet(
  testId: string,
  variantId: string,
  visitorHash: string,
  goals: ConversionGoal[],
  appUrl: string
): string {
  const goalsJson = JSON.stringify(
    goals.map((g) => ({
      id: g.id,
      type: g.type,
      selector: g.selector,
      urlPattern: g.url_pattern,
    }))
  );

  return `<script>
(function() {
  // Flag checked by tracker.js: when the inline snippet owns this page,
  // a hardcoded tracker.js tag must stay dormant or every lead/pageview
  // would be reported twice. Set before anything else so it is visible
  // regardless of script order.
  window.__SL_SNIPPET__ = true;
  var _SL = {
    testId: ${JSON.stringify(testId)},
    variantId: ${JSON.stringify(variantId)},
    visitorHash: ${JSON.stringify(visitorHash)},
    apiUrl: ${JSON.stringify(appUrl)},
    goals: ${goalsJson},
    _sent: {},
    send: function(payload) {
      if (navigator.sendBeacon) {
        try {
          var blob = new Blob([payload], { type: 'text/plain' });
          navigator.sendBeacon(this.apiUrl + '/api/event', blob);
          return;
        } catch(e) {}
      }
      fetch(this.apiUrl + '/api/event', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: payload,
        keepalive: true
      }).catch(function() {});
    },
    track: function(type, goalId) {
      var key = type + ':' + (goalId || '');
      if (this._sent[key]) return;
      this._sent[key] = true;
      this.send(JSON.stringify({
        testId: this.testId,
        variantId: this.variantId,
        goalId: goalId || null,
        visitorHash: this.visitorHash,
        type: type
      }));
    }
  };

  var _isScan = new URLSearchParams(window.location.search).get('sl_scan') === '1';

  // ─── Cross-page context persistence ─────────────────────────────────────────
  // Persist this test's context (variant, visitor, url_reached goals) keyed per
  // test, so a later SplitLab-served page on the SAME origin can fire this
  // test's URL goals after a full page navigation (e.g. /offer -> /booking).
  // localStorage is per-origin: this does NOT work across different domains or
  // subdomains (Calendly etc.) — that needs tracker.js on the destination plus
  // sl_vid link params, which is not implemented yet.
  var CTX_KEY = 'sl_ctx';
  var CTX_TTL = 90 * 24 * 60 * 60 * 1000; // 90 days, matches sl_visitor cookie

  function loadCtxMap() {
    try {
      var m = JSON.parse(localStorage.getItem(CTX_KEY) || '{}') || {};
      var now = Date.now();
      var changed = false;
      for (var k in m) {
        if (!m[k] || !m[k].ts || now - m[k].ts > CTX_TTL) { delete m[k]; changed = true; }
      }
      if (changed) localStorage.setItem(CTX_KEY, JSON.stringify(m));
      return m;
    } catch(e) { return {}; }
  }

  function saveCtx() {
    try {
      var m = loadCtxMap();
      m[_SL.testId] = {
        vid: _SL.variantId,
        vh: _SL.visitorHash,
        ts: Date.now(),
        urlGoals: _SL.goals
          .filter(function(g) { return g.type === 'url_reached' && g.urlPattern; })
          .map(function(g) { return { id: g.id, p: g.urlPattern }; })
      };
      localStorage.setItem(CTX_KEY, JSON.stringify(m));
    } catch(e) {}
  }

  // Fire conversions for OTHER tests' saved url_reached goals that match this
  // page's URL — attributed to the variant/visitor stored when the visitor saw
  // that test. Own-test goals are handled inline by checkUrlGoals().
  var _sentStored = {};
  function checkStoredUrlGoals() {
    if (_isScan) return;
    var m = loadCtxMap();
    var url = window.location.href;
    var pathname = window.location.pathname + window.location.search;
    for (var tid in m) {
      if (tid === _SL.testId) continue;
      var ctx = m[tid];
      (ctx.urlGoals || []).forEach(function(g) {
        if (_sentStored[g.id]) return;
        try {
          var pattern = new RegExp(g.p, 'i');
          if (pattern.test(url) || pattern.test(pathname)) {
            _sentStored[g.id] = true;
            _SL.send(JSON.stringify({
              testId: tid,
              variantId: ctx.vid,
              goalId: g.id,
              visitorHash: ctx.vh,
              type: 'conversion'
            }));
          }
        } catch(e) {}
      });
    }
  }

  // ─── Cross-domain linker (mirrors tracker.js) ───────────────────────────────
  // localStorage never crosses origins, so tag outbound cross-domain
  // navigations with sl_tid/sl_vid/sl_vh; tracker.js on the destination
  // rebuilds context from the params (detect Method 1) and strips them.
  function decorate(url) {
    try {
      if (!url) return url;
      var u = new URL(String(url), window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
      if (u.hostname === window.location.hostname) return url;
      if (u.searchParams.get('sl_vid') || u.searchParams.get('sl_tid')) return url;
      u.searchParams.set('sl_tid', _SL.testId);
      u.searchParams.set('sl_vid', _SL.variantId);
      u.searchParams.set('sl_vh', _SL.visitorHash);
      return u.toString();
    } catch(e) { return url; }
  }

  function decorateFromEvent(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href]');
    if (!a) return;
    try {
      var dec = decorate(a.href);
      if (dec !== a.href) a.href = dec;
    } catch(err) {}
  }

  function decorateFormForSubmit(form) {
    if (!form || !form.getAttribute) return;
    var action = form.getAttribute('action');
    if (!action) return;
    var dec = decorate(action);
    if (dec === action) return;
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    if (method === 'get') {
      // GET submits replace the action query string with the form fields,
      // so carry the params as hidden inputs instead
      ['sl_tid', 'sl_vid', 'sl_vh'].forEach(function(name) {
        if (form.querySelector && form.querySelector("input[name='" + name + "']")) return;
        var hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = name;
        hidden.value = name === 'sl_tid' ? _SL.testId : name === 'sl_vid' ? _SL.variantId : _SL.visitorHash;
        form.appendChild(hidden);
      });
    } else {
      form.setAttribute('action', dec);
    }
  }

  function patchWindowOpen() {
    try {
      var origOpen = window.open;
      if (!origOpen || origOpen.__sl_patched) return;
      var patched = function() {
        var args = Array.prototype.slice.call(arguments);
        if (args[0]) args[0] = decorate(String(args[0]));
        return origOpen.apply(window, args);
      };
      patched.__sl_patched = true;
      window.open = patched;
    } catch(e) {}
  }

  function watchNavigations() {
    // Navigation API (Baseline 2026): the only hook that sees JS redirects
    // (window.location.href = ...). Cancel undecorated cross-domain jumps and
    // re-issue them decorated. Older browsers skip this and keep today's
    // behavior; links/forms are already decorated earlier so they pass through.
    try {
      if (!window.navigation || !window.navigation.addEventListener) return;
      window.navigation.addEventListener('navigate', function(e) {
        try {
          if (!e.cancelable || e.formData || e.downloadRequest) return;
          if (e.navigationType !== 'push' && e.navigationType !== 'replace') return;
          var dest = e.destination && e.destination.url;
          var dec = decorate(dest);
          if (!dest || dec === dest) return;
          e.preventDefault();
          window.location.href = dec;
        } catch(err) {}
      });
    } catch(e) {}
  }

  if (!_isScan) {
    // mousedown precedes every click variant; middle-click fires auxclick
    // (not click) in some browsers — cover all three for new-tab opens
    document.addEventListener('mousedown', decorateFromEvent, true);
    document.addEventListener('auxclick', decorateFromEvent, true);
    document.addEventListener('click', decorateFromEvent, true);
    patchWindowOpen();
    watchNavigations();
  }

  // Auto-track pageview (skip on scan requests — sl_scan=1 means dashboard goal setup)
  if (!_isScan) {
    _SL.track('pageview');
    saveCtx();
  }

  // ─── Form lead capture helpers ──────────────────────────────────────────────

  // Accumulates field values across stepper steps so submit captures all steps' data
  var _accumulatedFormData = {};
  var _leadSent = false;

  function snapshotVisibleFormFields() {
    try {
      var inputs = document.querySelectorAll('input, select, textarea');
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        var t = (el.type || '').toLowerCase();
        if (t === 'password' || t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'file') continue;
        if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
        var key = el.name || el.id || el.getAttribute('placeholder') || null;
        if (key && el.value) _accumulatedFormData[key] = el.value;
      }
    } catch(e) {}
  }

  function sendFormLead(fields) {
    try {
      var sp = new URLSearchParams(window.location.search);
      var utm = {};
      ['utm_source','utm_medium','utm_content','utm_term','utm_campaign','gclid','fbclid'].forEach(function(k) {
        if (sp.get(k)) utm[k] = sp.get(k);
      });
      var payload = JSON.stringify({
        testId: _SL.testId,
        variantId: _SL.variantId,
        visitorHash: _SL.visitorHash,
        formFields: fields,
        utm: utm
      });
      if (navigator.sendBeacon) {
        try {
          var blob = new Blob([payload], { type: 'text/plain' });
          if (navigator.sendBeacon(_SL.apiUrl + '/api/form-leads', blob)) return;
        } catch(e) {}
      }
      var xhr = new XMLHttpRequest();
      xhr.open('POST', _SL.apiUrl + '/api/form-leads', true);
      xhr.withCredentials = false;
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.send(payload);
    } catch(e) {}
  }

  function captureFormLead(form) {
    if (_leadSent) return;
    _leadSent = true;
    try {
      // Start with accumulated data from previous stepper steps
      var fields = {};
      var k;
      for (k in _accumulatedFormData) { if (_accumulatedFormData.hasOwnProperty(k)) fields[k] = _accumulatedFormData[k]; }
      // Overlay current form's fields (name || id || placeholder as key)
      var elements = form ? form.elements : [];
      for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        var t = (el.type || '').toLowerCase();
        if (t === 'password' || t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'file') continue;
        if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
        var fkey = el.name || el.id || el.getAttribute('placeholder') || null;
        if (fkey) fields[fkey] = el.value || '';
      }
      sendFormLead(fields);
    } catch(e) {}
  }

  function captureFormLeadFromAccumulated() {
    if (_leadSent) return;
    var hasData = false;
    for (var k in _accumulatedFormData) {
      if (_accumulatedFormData.hasOwnProperty(k) && _accumulatedFormData[k]) { hasData = true; break; }
    }
    if (!hasData) return;
    _leadSent = true;
    sendFormLead(_accumulatedFormData);
  }

  function patchNetworkForJsSubmit() {
    try {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this._sl_method = method;
        this._sl_url = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        var method = (this._sl_method || '').toUpperCase();
        var url = this._sl_url || '';
        if (method === 'POST' && url.indexOf(_SL.apiUrl) !== 0 && url.indexOf('/api/') !== 0) {
          captureFormLeadFromAccumulated();
        }
        return origSend.apply(this, arguments);
      };
      var origFetch = window.fetch;
      window.fetch = function(input, init) {
        try {
          var method = (init && init.method || 'GET').toUpperCase();
          var url = (typeof input === 'string' ? input : (input && input.url)) || '';
          if (method === 'POST' && url.indexOf(_SL.apiUrl) !== 0 && url.indexOf('/api/') !== 0) {
            captureFormLeadFromAccumulated();
          }
        } catch(e) {}
        return origFetch.apply(this, arguments);
      };
    } catch(e) {}
  }

  // ─── Wire up conversion goals ────────────────────────────────────────────────

  function checkUrlGoals() {
    var url = window.location.href;
    var pathname = window.location.pathname + window.location.search;
    _SL.goals.forEach(function(goal) {
      if (goal.type !== 'url_reached' || !goal.urlPattern) return;
      try {
        var pattern = new RegExp(goal.urlPattern, 'i');
        if (pattern.test(url) || pattern.test(pathname)) _SL.track('conversion', goal.id);
      } catch(e) {}
    });
  }

  function initGoals() {
    var urlGoals = _SL.goals.filter(function(g) { return g.type === 'url_reached'; });
    // Check both this test's URL goals and other tests' goals saved in
    // localStorage (cross-page attribution after a full navigation)
    function checkAllUrlGoals() {
      if (urlGoals.length > 0) checkUrlGoals();
      checkStoredUrlGoals();
    }
    checkAllUrlGoals();
    function wrapHistory(method) {
      var orig = history[method];
      history[method] = function() { orig.apply(this, arguments); checkAllUrlGoals(); };
    }
    try { wrapHistory('pushState'); wrapHistory('replaceState'); } catch(e) {}
    window.addEventListener('popstate', function() { checkAllUrlGoals(); });
    window.addEventListener('hashchange', function() { checkAllUrlGoals(); });

    function cleanText(value) {
      return (value || '').replace(/\\s+/g, ' ').trim();
    }

    function fieldKey(field) {
      var tag = (field.tagName || '').toLowerCase();
      var type = (field.type || '').toLowerCase();
      if (type === 'password' || type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'file') return null;
      var key = cleanText(field.name || field.id || field.getAttribute('placeholder') || field.getAttribute('aria-label') || type || tag);
      return key ? encodeURIComponent(key.toLowerCase().slice(0, 80)) : null;
    }

    function formFieldSignature(form) {
      var seen = {};
      var fields = [];
      var inputs = form.querySelectorAll('input, select, textarea');
      for (var fi = 0; fi < inputs.length; fi++) {
        var key = fieldKey(inputs[fi]);
        if (!key || seen[key]) continue;
        seen[key] = true;
        fields.push(key);
      }
      if (!fields.length) return null;
      // Sort so field order in the DOM doesn't change the signature
      fields.sort();
      // Cap must match tracker.js so signatures compare equal across scripts
      var sig = fields.join('|');
      return sig.length > 300 ? sig.slice(0, 300) : sig;
    }

    function formSubmitText(form) {
      var submit = form.querySelector("button[type='submit'], input[type='submit'], button:not([type]), [role='button']");
      return submit ? cleanText(submit.textContent || submit.value || submit.getAttribute('aria-label')).slice(0, 100) : null;
    }

    // Capped identically to the scanners so selectors compare equal
    function formName(form) {
      if (!form || !form.getAttribute) return null;
      return (form.getAttribute('name') || '').slice(0, 150) || null;
    }

    // Resolve an id:/name:/text:/fields:/nth:/legacy-CSS selector to a list of DOM elements
    function resolveElements(selector, type) {
      if (!selector) {
        if (type === 'form_submit') return Array.from(document.querySelectorAll('form'));
        return [];
      }
      if (selector.indexOf('id:') === 0) {
        var byId = document.getElementById(selector.slice(3));
        return byId ? [byId] : [];
      }
      if (selector.indexOf('name:') === 0) {
        var targetName = selector.slice(5);
        if (type === 'form_submit') {
          return Array.from(document.querySelectorAll('form')).filter(function(form) {
            return formName(form) === targetName;
          });
        }
        if (type === 'button_click') {
          return Array.from(document.querySelectorAll("button, [role='button'], [role='switch'], input[type='submit'], input[type='button'], input[type='checkbox']")).filter(function(el) {
            return (el.getAttribute('name') || '') === targetName;
          });
        }
        return [];
      }
      if (selector.indexOf('text:') === 0) {
        var needle = selector.slice(5).toLowerCase();
        if (type === 'form_submit') {
          return Array.from(document.querySelectorAll('form')).filter(function(form) {
            return (formSubmitText(form) || '').toLowerCase() === needle;
          });
        }
        var candidates = document.querySelectorAll("button, [role='button'], [role='switch'], input[type='submit'], input[type='button'], input[type='checkbox'], a[href]");
        var matches = [];
        for (var ci = 0; ci < candidates.length; ci++) {
          var c = candidates[ci];
          var cText = (c.textContent || c.value || c.getAttribute('aria-label') || c.getAttribute('name') || '').trim().toLowerCase();
          if (!c.id && cText === needle) matches.push(c);
        }
        return matches;
      }
      if (selector.indexOf('fields:') === 0 && type === 'form_submit') {
        var targetFields = selector.slice(7);
        return Array.from(document.querySelectorAll('form')).filter(function(form) {
          return formFieldSignature(form) === targetFields;
        });
      }
      if (selector.indexOf('nth:') === 0 && type === 'form_submit') {
        var nthForms = document.querySelectorAll('form');
        var nth = parseInt(selector.slice(4), 10);
        return !isNaN(nth) && nthForms[nth] ? [nthForms[nth]] : [];
      }
      // Legacy CSS selector (e.g. #my-form, .cta-btn)
      try {
        return Array.from(document.querySelectorAll(selector));
      } catch(e) { return []; }
    }

    // Pre-collect forms claimed by specific goals so the null-selector catch-all
    // doesn't attach a second listener to those same elements.
    var specificFormEls = [];
    _SL.goals.forEach(function(goal) {
      if (goal.type === 'form_submit' && goal.selector) {
        resolveElements(goal.selector, 'form_submit').forEach(function(form) {
          specificFormEls.push(form);
        });
      }
    });

    _SL.goals.forEach(function(goal) {
      if (goal.type === 'url_reached') {
        // handled above
      } else if (goal.type === 'form_submit') {
        resolveElements(goal.selector, 'form_submit').forEach(function(form) {
          if (!goal.selector && specificFormEls.indexOf(form) !== -1) return;
          form.addEventListener('submit', function(e) {
            var action = form.getAttribute('action') || '';
            if (!action || action === '#') e.preventDefault();
            captureFormLead(form);
            _SL.track('conversion', goal.id);
          });
        });
      } else if (goal.type === 'button_click') {
        resolveElements(goal.selector, 'button_click').forEach(function(el) {
          var evt = (el.tagName === 'INPUT' && el.type === 'checkbox') ? 'change' : 'click';
          el.addEventListener(evt, function() {
            _SL.track('conversion', goal.id);
          });
        });
      } else if (goal.type === 'call_click') {
        document.querySelectorAll('a[href^="tel:"]').forEach(function(el) {
          el.addEventListener('click', function() {
            _SL.track('conversion', goal.id);
          });
        });
      }
    });

    // Global form submit — captures all forms (not just goal-targeted ones)
    document.addEventListener('submit', function(e) {
      if (!_isScan) decorateFormForSubmit(e.target);
      captureFormLead(e.target);
    }, true);

    // Global button click — snapshot fields for stepper + submit-keyword detection
    document.addEventListener('click', function(e) {
      var el = e.target;
      if (!el || !el.closest) return;
      var btn = el.closest("button, [role='button'], input[type='submit'], input[type='button']");
      if (!btn) return;
      snapshotVisibleFormFields();
      if (!_leadSent) {
        var btnText = (btn.textContent || btn.value || '').trim();
        var submitWords = /^(submit|send|get|book|schedule|contact|request|apply|sign up|register|subscribe|confirm|continue|finish|complete|done|go|start|claim|unlock|download|access)/i;
        if (submitWords.test(btnText)) {
          setTimeout(function() { captureFormLeadFromAccumulated(); }, 100);
        }
      }
    }, true);

    patchNetworkForJsSubmit();
  }

  // One-shot only, unlike tracker.js's watchForNewFields() MutationObserver — hosted
  // variant HTML is fetched from Storage in full up front, so a later scan/registration
  // pass isn't needed for fields that are merely CSS-hidden. A field that a page's own JS
  // injects into the DOM only after some interaction would still be missed here.
  function registerFormFields() {
    try {
      var seen = {};
      var fields = [];
      var inputs = document.querySelectorAll('input, select, textarea');
      for (var ri = 0; ri < inputs.length; ri++) {
        var rel = inputs[ri];
        var rt = (rel.type || '').toLowerCase();
        if (rt === 'password' || rt === 'hidden' || rt === 'submit' || rt === 'button' || rt === 'reset' || rt === 'file') continue;
        var rname = rel.name || rel.id || rel.getAttribute('placeholder') || null;
        if (!rname || seen[rname]) continue;
        seen[rname] = true;
        fields.push(rname);
      }
      if (fields.length === 0) return;
      var rxhr = new XMLHttpRequest();
      rxhr.open('POST', _SL.apiUrl + '/api/register-form-fields', true);
      rxhr.withCredentials = false;
      rxhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      rxhr.send(JSON.stringify({ variantId: _SL.variantId, fields: fields }));
    } catch(e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { initGoals(); registerFormFields(); });
  } else {
    initGoals();
    registerFormFields();
  }

  window.SplitLab = _SL;
})();
</script>`;
}

/**
 * Remove SplitLab tracker.js <script> tags baked into variant HTML.
 * HTML variants get the inline tracking snippet injected at serve time,
 * so a hardcoded tracker.js on the same page double-reports every
 * lead/pageview/conversion (and can attribute them to a stale variant
 * from localStorage). Only strips tags whose src points at a SplitLab
 * host — client/third-party scripts are never touched.
 */
export function stripSplitLabTrackerTags(html: string, appUrl: string): string {
  let appHost = '';
  try { appHost = new URL(appUrl).host; } catch { /* keep '' */ }

  return html.replace(
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (tag, src: string) => {
      if (!/\/tracker\.js([?#]|$)/i.test(src)) return tag;
      try {
        const host = new URL(src, appUrl).host;
        const isSplitLabHost =
          host === appHost ||
          /(^|\.)trysplitlab\.com$/i.test(host) ||
          /^localhost(:\d+)?$/.test(host) ||
          /^127\.0\.0\.1(:\d+)?$/.test(host);
        if (isSplitLabHost) return '';
      } catch { /* unparseable src — leave the tag alone */ }
      return tag;
    }
  );
}

/**
 * Inject workspace scripts and tracking snippet into raw HTML.
 */
export function injectIntoHtml(
  html: string,
  headScripts: string[],
  bodyEndScripts: string[],
  trackingSnippet: string
): string {
  let result = html;

  // Inject head scripts before </head>
  if (headScripts.length > 0) {
    const headContent = headScripts.join('\n');
    if (result.includes('</head>')) {
      result = result.replace('</head>', `${headContent}\n</head>`);
    } else {
      result = headContent + '\n' + result;
    }
  }

  // Inject body-end scripts + tracking before </body>
  const bodyEndContent = [...bodyEndScripts, trackingSnippet].join('\n');
  if (result.includes('</body>')) {
    result = result.replace('</body>', `${bodyEndContent}\n</body>`);
  } else {
    result = result + '\n' + bodyEndContent;
  }

  return result;
}

/**
 * Build a standalone scan script injected into custom HTML / proxy pages when
 * sl_scan=1 is present. Scans the DOM and POSTs results to /api/scan.
 */
export function buildScanScript(variantId: string, appUrl: string): string {
  return `<script>
(function() {
  var vid = ${JSON.stringify(variantId)};
  var scanUrl = ${JSON.stringify(appUrl + '/api/scan')};
  var scanBanner = null;
  var closePending = false;
  function scheduleClose(fallbackHtml) {
    if (closePending) return;
    closePending = true;
    setTimeout(function() {
      window.close();
      setTimeout(function() {
        if (scanBanner) scanBanner.innerHTML = fallbackHtml;
      }, 100);
    }, 5000);
  }
  function showScanBanner() {
    scanBanner = document.createElement('div');
    scanBanner.setAttribute('style', [
      'position:fixed','bottom:20px','right:20px','z-index:2147483647',
      'background:#16a34a','color:#fff',
      'padding:10px 16px','border-radius:10px',
      'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
      'font-size:13px','font-weight:600','letter-spacing:0.01em',
      'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
      'display:flex','align-items:center','gap:8px',
      'max-width:320px','transition:background 0.3s'
    ].join(';'));
    scanBanner.innerHTML = '<span style="font-size:15px">✦</span><span>Detecting events within your page that you can track</span>';
    document.body.appendChild(scanBanner);
  }
  function cleanText(value) {
    return (value || '').replace(/\\s+/g, ' ').trim();
  }
  function fieldKey(field) {
    var tag = (field.tagName || '').toLowerCase();
    var type = (field.type || '').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'file') return null;
    var key = cleanText(field.name || field.id || field.getAttribute('placeholder') || field.getAttribute('aria-label') || type || tag);
    return key ? encodeURIComponent(key.toLowerCase().slice(0, 80)) : null;
  }
  function formFieldSignature(form) {
    var seen = {};
    var fields = [];
    var inputs = form.querySelectorAll('input, select, textarea');
    for (var fi = 0; fi < inputs.length; fi++) {
      var key = fieldKey(inputs[fi]);
      if (!key || seen[key]) continue;
      seen[key] = true;
      fields.push(key);
    }
    if (!fields.length) return null;
    // Sort so field order in the DOM doesn't change the signature
    fields.sort();
    // Cap must match tracker.js so signatures compare equal across scripts
    var sig = fields.join('|');
    return sig.length > 300 ? sig.slice(0, 300) : sig;
  }
  function formSubmitText(form) {
    var submit = form.querySelector("button[type='submit'], input[type='submit'], button:not([type]), [role='button']");
    return submit ? cleanText(submit.textContent || submit.value || submit.getAttribute('aria-label')).slice(0, 100) : null;
  }
  function incrementCount(counts, key) {
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
  }
  // Read id/name via getAttribute: named inputs (e.g. <input name="id">) shadow
  // form.id / form.name with the element itself instead of the attribute string.
  // Capped identically to tracker.js so selectors compare equal across scripts.
  function formId(form) {
    if (!form || !form.getAttribute) return null;
    return (form.getAttribute('id') || '').slice(0, 255) || null;
  }
  function formName(form) {
    if (!form || !form.getAttribute) return null;
    return (form.getAttribute('name') || '').slice(0, 150) || null;
  }
  function collectFormSelectorCounts(forms) {
    var counts = {};
    for (var ci = 0; ci < forms.length; ci++) {
      var form = forms[ci];
      var name = formName(form);
      incrementCount(counts, name ? 'name:' + name : null);
      var submitText = formSubmitText(form);
      incrementCount(counts, submitText ? 'text:' + submitText.toLowerCase() : null);
      var fields = formFieldSignature(form);
      incrementCount(counts, fields ? 'fields:' + fields : null);
    }
    return counts;
  }
  // Selector priority: content-based identity (id/name/submit text/fields) first,
  // DOM position (nth:) strictly last. Position breaks silently when the DOM changes:
  // injected popup/chat-widget forms shift the index, SPA mount order varies, and
  // page edits renumber every form. Content survives reordering; position does not.
  function formSelector(form, counts, idx) {
    var fid = formId(form);
    if (fid) return 'id:' + fid;
    var name = formName(form);
    if (name && (!counts || counts['name:' + name] === 1)) return 'name:' + name;
    var submitText = formSubmitText(form);
    if (submitText && (!counts || counts['text:' + submitText.toLowerCase()] === 1)) return 'text:' + submitText;
    var fields = formFieldSignature(form);
    if (fields && (!counts || counts['fields:' + fields] === 1)) return 'fields:' + fields;
    return typeof idx === 'number' && idx >= 0 ? 'nth:' + idx : null;
  }
  // Display label = form identity, NOT submit-button text (that confuses forms with buttons).
  // Priority mirrors the selector: id → name → fields → nth → submit text last.
  function formLabel(form, selector) {
    var fid = formId(form);
    if (fid) return ('#' + fid).slice(0, 100);
    var name = formName(form);
    if (name) return name.slice(0, 100);
    if (selector && selector.indexOf('fields:') === 0) {
      return selector.slice(7).split('|').map(decodeURIComponent).join(', ').slice(0, 100) || null;
    }
    if (selector && selector.indexOf('nth:') === 0) {
      var n = parseInt(selector.slice(4), 10);
      return !isNaN(n) ? 'Form #' + (n + 1) : 'Form';
    }
    var submitText = formSubmitText(form);
    return submitText ? ('Form (“' + submitText + '”)').slice(0, 100) : 'Form';
  }
  function buttonVisibleText(btn) {
    return cleanText(btn.textContent || btn.value || '').slice(0, 100) || null;
  }
  // Buttons: id → visible text → unique name → aria-label (as text:).
  // No nth: pages have dozens of buttons; chat/cookie widgets inject more and
  // shift indexes constantly, so position is too fragile to be useful.
  function buttonSelector(btn, nameCounts) {
    var bid = (btn.getAttribute('id') || '').slice(0, 255) || null;
    if (bid) return 'id:' + bid;
    var text = buttonVisibleText(btn);
    if (text) return 'text:' + text;
    var name = (btn.getAttribute('name') || '').slice(0, 150) || null;
    if (name && (!nameCounts || nameCounts[name] === 1)) return 'name:' + name;
    var aria = cleanText(btn.getAttribute('aria-label')).slice(0, 100) || null;
    if (aria) return 'text:' + aria;
    return null;
  }
  function buttonLabel(btn, selector) {
    var bid = (btn.getAttribute('id') || '').slice(0, 255) || null;
    if (bid) return ('#' + bid).slice(0, 100);
    var text = buttonVisibleText(btn);
    if (text) return text;
    if (selector && selector.indexOf('name:') === 0) return selector.slice(5);
    if (selector && selector.indexOf('text:') === 0) return selector.slice(5);
    return 'Button';
  }
  function toggleAssociatedLabel(cb) {
    var aria = cleanText(cb.getAttribute('aria-label'));
    if (aria) return aria.slice(0, 100);
    var name = (cb.getAttribute('name') || '').slice(0, 150) || null;
    if (name) return name;
    var cid = (cb.getAttribute('id') || '') || null;
    if (cid) {
      var labels = document.querySelectorAll('label[for]');
      for (var li = 0; li < labels.length; li++) {
        if (labels[li].htmlFor === cid) {
          var t = cleanText(labels[li].textContent).slice(0, 100);
          if (t) return t;
        }
      }
    }
    var parent = cb.closest ? cb.closest('label') : null;
    if (parent) {
      var pt = cleanText(parent.textContent).slice(0, 100);
      if (pt) return pt;
    }
    return null;
  }
  // Toggles: id → aria-label (text:) → name (name:) → associated <label> text.
  // No nth — same reason as buttons.
  function toggleSelector(cb) {
    var cid = (cb.getAttribute('id') || '').slice(0, 255) || null;
    if (cid) return 'id:' + cid;
    var aria = cleanText(cb.getAttribute('aria-label')).slice(0, 100) || null;
    if (aria) return 'text:' + aria;
    var name = (cb.getAttribute('name') || '').slice(0, 150) || null;
    if (name) return 'name:' + name;
    var label = toggleAssociatedLabel(cb);
    return label ? 'text:' + label : null;
  }
  function toggleLabel(cb, selector) {
    var cid = (cb.getAttribute('id') || '').slice(0, 255) || null;
    if (cid) return ('#' + cid).slice(0, 100);
    if (selector && selector.indexOf('name:') === 0) return selector.slice(5);
    if (selector && selector.indexOf('text:') === 0) return selector.slice(5);
    return toggleAssociatedLabel(cb) || 'Toggle';
  }
  // Single-pass only, unlike tracker.js's startStepperObserver() — the full hosted
  // page HTML is already in the DOM at scan time (querySelectorAll sees CSS-hidden
  // steps too), so no MutationObserver re-scan is needed for typical multi-step forms.
  // A step whose markup is injected by the page's own JS only after interaction
  // would still be missed until the visitor reaches it.
  function runScan() {
    var elements = [];
    var forms = document.querySelectorAll('form');
    var formCounts = collectFormSelectorCounts(forms);
    for (var i = 0; i < forms.length; i++) {
      var form = forms[i];
      var selector = formSelector(form, formCounts, i);
      elements.push({ type: 'form', id: formId(form), text: formLabel(form, selector), selector: selector });
    }
    var buttons = document.querySelectorAll("button, [role='button'], [role='switch'], input[type='submit'], input[type='button']");
    var buttonNameCounts = {};
    for (var bj = 0; bj < buttons.length; bj++) {
      var bn = (buttons[bj].getAttribute('name') || '').slice(0, 150) || null;
      if (bn) buttonNameCounts[bn] = (buttonNameCounts[bn] || 0) + 1;
    }
    for (var j = 0; j < buttons.length; j++) {
      var btn = buttons[j];
      var bSel = buttonSelector(btn, buttonNameCounts);
      elements.push({ type: 'button', id: (btn.getAttribute('id') || '').slice(0, 255) || null, text: buttonLabel(btn, bSel), selector: bSel });
    }
    var checkboxes = document.querySelectorAll("input[type='checkbox']");
    for (var m = 0; m < checkboxes.length; m++) {
      var cb = checkboxes[m];
      var tSel = toggleSelector(cb);
      elements.push({ type: 'toggle', id: (cb.getAttribute('id') || '').slice(0, 255) || null, text: toggleLabel(cb, tSel), selector: tSel });
    }
    var links = document.querySelectorAll('a');
    for (var k = 0; k < links.length; k++) {
      var link = links[k];
      var href = link.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || href.indexOf('javascript:') === 0) continue;
      var type = href.indexOf('tel:') === 0 ? 'call' : 'link';
      elements.push({ type: type, id: link.id || null, text: (link.textContent || href).trim().slice(0, 100) || null });
    }
    function failBanner() {
      if (!scanBanner) return;
      scanBanner.setAttribute('style', [
        'position:fixed','bottom:20px','right:20px','z-index:2147483647',
        'background:#dc2626','color:#fff',
        'padding:10px 16px','border-radius:10px',
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
        'font-size:13px','font-weight:600','letter-spacing:0.01em',
        'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
        'display:flex','align-items:center','gap:8px','max-width:320px'
      ].join(';'));
      scanBanner.innerHTML = '<span style="font-size:15px">✕</span><span>Could not detect events on this page</span>';
      scheduleClose('<span style="font-size:15px">✕</span><span>Could not detect events — you can close this tab</span>');
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', scanUrl, true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300 && scanBanner) {
          scanBanner.innerHTML = '<span style="font-size:15px">✓</span><span>Scan completed</span>';
          scheduleClose('<span style="font-size:15px">✓</span><span>Scan complete — you can close this tab</span>');
        } else {
          failBanner();
        }
      };
      xhr.onerror = function() { failBanner(); };
      xhr.send(JSON.stringify({ vid: vid, elements: elements }));
    } catch(e) { failBanner(); }
  }
  function init() {
    showScanBanner();
    runScan();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>`;
}

/**
 * Build a <script> tag for a known script type.
 */
export function buildScriptTag(type: string, content: string): string {
  switch (type) {
    case 'gtm':
      return `<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${content}');</script>
<!-- End Google Tag Manager -->`;

    case 'meta_pixel':
      return `<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${content}');
fbq('track', 'PageView');
</script>
<!-- End Meta Pixel Code -->`;

    case 'ga4':
      return `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${content}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${content}');
</script>`;

    case 'custom':
    default:
      return content;
  }
}



1. COMMIT:
Skip to content
rkrieg
SplitLab
Repository navigation
Code
Issues
Pull requests
Agents
Actions
Projects
Wiki
Security and quality
Insights
Settings
Commit c55de6f
HunbalAvenir
HunbalAvenir
committed
2 days ago
·
·
Verified
Add cross-domain linker to the inline HTML-page snippet so conversions survive jumps from hosted pages to outside domains
conversion-url-fixes
1 parent 
7b4fb22
 commit 
c55de6f
1 file changed

+76
Lines changed: 76 additions & 0 deletions
File tree
Filter files…
src/lib
tracking.ts
Search within code
 
‎src/lib/tracking.ts‎
+76
Lines changed: 76 additions & 0 deletions
Original file line number	Diff line number	Diff line change
@@ -135,6 +135,81 @@ export function buildTrackingSnippet(
    }
  }
  // ─── Cross-domain linker (mirrors tracker.js) ───────────────────────────────
  // localStorage never crosses origins, so tag outbound cross-domain
  // navigations with sl_tid/sl_vid/sl_vh; tracker.js on the destination
  // rebuilds context from the params (detect Method 1) and strips them.
  function decorate(url) {
    try {
      if (!url) return url;
      var u = new URL(String(url), window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
      if (u.hostname === window.location.hostname) return url;
      if (u.searchParams.get('sl_vid') || u.searchParams.get('sl_tid')) return url;
      u.searchParams.set('sl_tid', _SL.testId);
      u.searchParams.set('sl_vid', _SL.variantId);
      u.searchParams.set('sl_vh', _SL.visitorHash);
      return u.toString();
    } catch(e) { return url; }
  }
  function decorateFromEvent(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href]');
    if (!a) return;
    try {
      var dec = decorate(a.href);
      if (dec !== a.href) a.href = dec;
    } catch(err) {}
  }
  function decorateFormForSubmit(form) {
    if (!form || !form.getAttribute) return;
    var action = form.getAttribute('action');
    if (!action) return;
    var dec = decorate(action);
    if (dec === action) return;
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    if (method === 'get') {
      // GET submits replace the action query string with the form fields,
      // so carry the params as hidden inputs instead
      ['sl_tid', 'sl_vid', 'sl_vh'].forEach(function(name) {
        if (form.querySelector && form.querySelector("input[name='" + name + "']")) return;
        var hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = name;
        hidden.value = name === 'sl_tid' ? _SL.testId : name === 'sl_vid' ? _SL.variantId : _SL.visitorHash;
        form.appendChild(hidden);
      });
    } else {
      form.setAttribute('action', dec);
    }
  }
  function patchWindowOpen() {
    try {
      var origOpen = window.open;
      if (!origOpen || origOpen.__sl_patched) return;
      var patched = function() {
        var args = Array.prototype.slice.call(arguments);
        if (args[0]) args[0] = decorate(String(args[0]));
        return origOpen.apply(window, args);
      };
      patched.__sl_patched = true;
      window.open = patched;
    } catch(e) {}
  }
  if (!_isScan) {
    // mousedown precedes every click variant; middle-click fires auxclick
    // (not click) in some browsers — cover all three for new-tab opens
    document.addEventListener('mousedown', decorateFromEvent, true);
    document.addEventListener('auxclick', decorateFromEvent, true);
    document.addEventListener('click', decorateFromEvent, true);
    patchWindowOpen();
  }
  // Auto-track pageview (skip on scan requests — sl_scan=1 means dashboard goal setup)
  if (!_isScan) {
    _SL.track('pageview');
@@ -424,6 +499,7 @@ export function buildTrackingSnippet(
    // Global form submit — captures all forms (not just goal-targeted ones)
    document.addEventListener('submit', function(e) {
      if (!_isScan) decorateFormForSubmit(e.target);
      captureFormLead(e.target);
    }, true);
0 commit comments
Comments
0
 (0)
Comment
You're not receiving notifications from this thread.





2. COMMIT:
Skip to content
rkrieg
SplitLab
Repository navigation
Code
Issues
Pull requests
Agents
Actions
Projects
Wiki
Security and quality
Insights
Settings
Commit 7b4fb22
HunbalAvenir
HunbalAvenir
committed
2 days ago
Carry tracking params across domains by auto-decorating outbound links, forms and window.open in tracker.js so conversions keep working after cross-domain jumps, redirect mode only
1 parent 
e574dc3
 commit 
7b4fb22
1 file changed

+103
-1
Lines changed: 103 additions & 1 deletion
File tree
Filter files…
src/app/tracker.js
route.ts
Search within code
 
‎src/app/tracker.js/route.ts‎
+103
-1
Lines changed: 103 additions & 1 deletion
Original file line number	Diff line number	Diff line change
@@ -98,6 +98,47 @@ function buildTrackerScript(appUrl: string): string {
    } catch(e) {}
  }
  // ─── Cross-domain linker (like GA4's _gl) ───────────────────────────────────
  // localStorage never crosses origins, so the only way context survives a jump
  // to another domain is in the URL itself. Decorate outbound cross-domain
  // navigations with sl_tid/sl_vid/sl_vh; detect() Method 1 rebuilds context on
  // the destination and cleanUrl() strips the params there.
  function decorate(url) {
    try {
      if (!_ctx || !url) return url;
      var u = new URL(String(url), window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return url;
      if (u.hostname === window.location.hostname) return url;
      if (u.searchParams.get("sl_vid") || u.searchParams.get("sl_tid")) return url;
      u.searchParams.set("sl_tid", _ctx.tid);
      u.searchParams.set("sl_vid", _ctx.vid);
      u.searchParams.set("sl_vh", _ctx.vh);
      return u.toString();
    } catch(e) { return url; }
  }
  function decorateLink(a) {
    try {
      var dec = decorate(a.href);
      if (dec !== a.href) a.href = dec;
    } catch(e) {}
  }
  function patchWindowOpen() {
    try {
      var origOpen = window.open;
      if (!origOpen || origOpen.__sl_patched) return;
      var patched = function() {
        var args = Array.prototype.slice.call(arguments);
        if (args[0]) args[0] = decorate(String(args[0]));
        return origOpen.apply(window, args);
      };
      patched.__sl_patched = true;
      window.open = patched;
    } catch(e) {}
  }
  // ─── Scan mode ─────────────────────────────────────────────────────────────
  var _scanBanner = null;
@@ -779,6 +820,30 @@ function buildTrackerScript(appUrl: string): string {
    document.addEventListener("submit", function(e) {
      var form = e.target;
      // Read action via getAttribute — an input named "action" shadows form.action
      if (form && form.getAttribute) {
        var slAction = form.getAttribute("action");
        if (slAction) {
          var decAction = decorate(slAction);
          if (decAction !== slAction) {
            var slMethod = (form.getAttribute("method") || "get").toLowerCase();
            if (slMethod === "get") {
              // GET submits replace the action's query string with the form
              // fields, so carry the params as hidden inputs instead
              ["sl_tid", "sl_vid", "sl_vh"].forEach(function(name) {
                if (form.querySelector && form.querySelector("input[name='" + name + "']")) return;
                var hidden = document.createElement("input");
                hidden.type = "hidden";
                hidden.name = name;
                hidden.value = name === "sl_tid" ? _ctx.tid : name === "sl_vid" ? _ctx.vid : _ctx.vh;
                form.appendChild(hidden);
              });
            } else {
              form.setAttribute("action", decAction);
            }
          }
        }
      }
      _leadSent = true; // prevent JS-submit patch from double-sending
      captureFormLead(form);
      var formNth = form ? formDocumentIndex(form) : -1;
@@ -792,9 +857,22 @@ function buildTrackerScript(appUrl: string): string {
      });
    }, true);
    // Decorate cross-domain links before the browser follows them. mousedown
    // precedes every click variant, and middle-click fires auxclick (not click)
    // in some browsers — cover all three so new-tab opens are decorated too.
    function decorateFromEvent(e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var a = t.closest("a[href]");
      if (a) decorateLink(a);
    }
    document.addEventListener("mousedown", decorateFromEvent, true);
    document.addEventListener("auxclick", decorateFromEvent, true);
    document.addEventListener("click", function(e) {
      var el = e.target;
      if (!el || !el.closest) return;
      decorateFromEvent(e);
      // Check for tel: link clicks (call conversions)
      var link = el.closest("a[href^='tel:']");
@@ -881,7 +959,24 @@ function buildTrackerScript(appUrl: string): string {
    var vh  = params.get("sl_vh");
    if (tid && vid && vh) {
      cleanUrl(["sl_tid", "sl_vid", "sl_vh", "sl_scan"]);
      return callback({ tid: tid, vid: vid, vh: vh, goals: [] });
      // Fetch goals so url_reached patterns can fire on this page too (params
      // may arrive via cross-domain link decoration, not just a SplitLab 302)
      var xhr0 = new XMLHttpRequest();
      xhr0.open("GET", RESOLVE_URL + "?vid=" + encodeURIComponent(vid), true);
      xhr0.withCredentials = false;
      xhr0.onload = function() {
        var goals = [];
        try {
          var data = JSON.parse(xhr0.responseText);
          if (data.goals) goals = data.goals;
        } catch(e) {}
        callback({ tid: tid, vid: vid, vh: vh, goals: goals });
      };
      xhr0.onerror = function() {
        callback({ tid: tid, vid: vid, vh: vh, goals: [] });
      };
      xhr0.send();
      return;
    }
    // Method 2: Variant ID only (?sl_vid=xxx) — resolve test ID + goals via API
@@ -974,6 +1069,7 @@ function buildTrackerScript(appUrl: string): string {
      registerFormFields();
      watchForNewFields();
      patchNetworkForJsSubmit();
      patchWindowOpen();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
@@ -990,6 +1086,12 @@ function buildTrackerScript(appUrl: string): string {
    },
    getContext: function() { return _ctx; },
    isActive: function() { return !!_ctx; }
    // Manual escape hatch for JS-driven cross-domain redirects
    // (window.location.href can't be intercepted by any script):
    //   SplitLab.go(url) instead of window.location.href = url
    // Disabled for now — uncomment to expose:
    // ,decorate: function(url) { return decorate(url); },
    // go: function(url) { window.location.href = decorate(url); }
  };
  // Auto-detect and boot — no init() call needed
0 commit comments
Comments
0
 (0)


