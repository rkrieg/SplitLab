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
        var blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(EVENT_URL, blob);
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", EVENT_URL, true);
        xhr.withCredentials = false;
        xhr.setRequestHeader("Content-Type", "application/json");
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

  function collectElements() {
    var elements = [];

    var forms = document.querySelectorAll("form");
    for (var i = 0; i < forms.length; i++) {
      if (inBanner(forms[i])) continue;
      elements.push({ type: "form", id: forms[i].id || null, text: null });
    }

    var buttons = document.querySelectorAll("button, [role='button'], [role='switch'], input[type='submit'], input[type='button']");
    for (var j = 0; j < buttons.length; j++) {
      var btn = buttons[j];
      if (inBanner(btn)) continue;
      elements.push({
        type: "button",
        id: btn.id || null,
        text: (btn.textContent || btn.value || "").trim().slice(0, 100) || null
      });
    }

    var checkboxes = document.querySelectorAll("input[type='checkbox']");
    for (var m = 0; m < checkboxes.length; m++) {
      var cb = checkboxes[m];
      if (inBanner(cb)) continue;
      elements.push({
        type: "toggle",
        id: cb.id || null,
        text: cb.getAttribute("aria-label") || cb.name || null
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
    xhr.setRequestHeader("Content-Type", "application/json");
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
      _scannedKeys[el.type + "|" + (el.id || "") + "|" + (el.text || "")] = true;
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
          var key = e.type + "|" + (e.id || "") + "|" + (e.text || "");
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
          var key = e2.type + "|" + (e2.id || "") + "|" + (e2.text || "");
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
    var key = type + ":" + (goalId || "") + ":" + (meta && meta.trigger || "");
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
      var inputs = document.querySelectorAll("input[name], select[name], textarea[name]");
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        if (!el.name) continue;
        var t = (el.type || "").toLowerCase();
        if (t === "password" || t === "hidden" || t === "submit" || t === "button" || t === "reset" || t === "file") continue;
        if ((t === "checkbox" || t === "radio") && !el.checked) continue;
        if (el.value) _accumulatedFormData[el.name] = el.value;
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
        if (!el.name) continue;
        var t = (el.type || "").toLowerCase();
        if (t === "password" || t === "hidden" || t === "submit" || t === "button" || t === "reset" || t === "file") continue;
        if ((t === "checkbox" || t === "radio") && !el.checked) continue;
        fields[el.name] = el.value || "";
      }
      var sp = new URLSearchParams(window.location.search);
      var utm = {};
      ["utm_source","utm_medium","utm_content","utm_term","utm_campaign","gclid"].forEach(function(k) {
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
          var blob = new Blob([payload], { type: "application/json" });
          if (navigator.sendBeacon(FORM_LEADS_URL, blob)) return;
        } catch(e) {}
      }
      var xhr = new XMLHttpRequest();
      xhr.open("POST", FORM_LEADS_URL, true);
      xhr.withCredentials = false;
      xhr.setRequestHeader("Content-Type", "application/json");
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
    ["utm_source","utm_medium","utm_content","utm_term","utm_campaign","gclid"].forEach(function(key) {
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
      var blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon && navigator.sendBeacon(FORM_LEADS_URL, blob)) return;
    } catch(e) {}
    var xhr2 = new XMLHttpRequest();
    xhr2.open("POST", FORM_LEADS_URL, true);
    xhr2.withCredentials = false;
    xhr2.setRequestHeader("Content-Type", "application/json");
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
      xhr.setRequestHeader("Content-Type", "application/json");
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
        track("conversion", null, { trigger: "button_click", id: el.id || null, text: el.getAttribute("aria-label") || el.name || null });
      }
    }, true);

    document.addEventListener("submit", function(e) {
      var form = e.target;
      _leadSent = true; // prevent JS-submit patch from double-sending
      captureFormLead(form);
      track("conversion", null, { trigger: "form_submit", id: (form && form.id) || null });
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
        track("conversion", null, { trigger: "button_click", text: (btn.textContent || btn.value || "").trim().slice(0, 50), id: btn.id || null });
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

    // Fire pageview immediately
    track("pageview");

    function onReady() {
      wireUrlGoals();
      wireAutoConversions();
      registerFormFields();
      watchForNewFields();
      patchNetworkForJsSubmit();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onReady);
    } else {
      onReady();
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
