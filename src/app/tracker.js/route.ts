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
  function showScanBanner() {
    if (_scanBanner) return;
    _scanBanner = document.createElement('div');
    _scanBanner.setAttribute('style', [
      'position:fixed','bottom:20px','right:20px','z-index:2147483647',
      'background:#16a34a','color:#fff',
      'padding:10px 16px','border-radius:10px',
      'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
      'font-size:13px','font-weight:600','letter-spacing:0.01em',
      'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
      'display:flex','align-items:center','gap:8px','max-width:320px'
    ].join(';'));
    _scanBanner.innerHTML = '<span style="font-size:15px">✦</span><span>Detecting events within your page that you can track</span>';
    document.body.appendChild(_scanBanner);
  }
  function completeScanBanner() {
    if (_scanBanner) {
      _scanBanner.innerHTML = '<span style="font-size:15px">✓</span><span>Scan completed</span>';
    }
  }
  function failScanBanner() {
    if (_scanBanner) {
      _scanBanner.setAttribute('style', [
        'position:fixed','bottom:20px','right:20px','z-index:2147483647',
        'background:#dc2626','color:#fff',
        'padding:10px 16px','border-radius:10px',
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
        'font-size:13px','font-weight:600','letter-spacing:0.01em',
        'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
        'display:flex','align-items:center','gap:8px','max-width:320px'
      ].join(';'));
      _scanBanner.innerHTML = '<span style="font-size:15px">✕</span><span>Could not detect events on this page</span>';
    }
  }

  function runScan(vid) {
    var elements = [];

    // Forms
    var forms = document.querySelectorAll("form");
    for (var i = 0; i < forms.length; i++) {
      elements.push({ type: "form", id: forms[i].id || null, text: null });
    }

    // All buttons + submit inputs + switches
    var buttons = document.querySelectorAll("button, [role='button'], [role='switch'], input[type='submit'], input[type='button']");
    for (var j = 0; j < buttons.length; j++) {
      var btn = buttons[j];
      elements.push({
        type: "button",
        id: btn.id || null,
        text: (btn.textContent || btn.value || "").trim().slice(0, 100) || null
      });
    }

    // Checkboxes
    var checkboxes = document.querySelectorAll("input[type='checkbox']");
    for (var m = 0; m < checkboxes.length; m++) {
      var cb = checkboxes[m];
      elements.push({
        type: "toggle",
        id: cb.id || null,
        text: cb.getAttribute("aria-label") || cb.name || null
      });
    }

    // All links (tel: → call, everything else → link)
    var links = document.querySelectorAll("a");
    for (var k = 0; k < links.length; k++) {
      var link = links[k];
      var href = link.getAttribute("href") || "";
      if (!href || href.charAt(0) === "#" || href.indexOf("javascript:") === 0) continue;
      var type = href.indexOf("tel:") === 0 ? "call" : "link";
      elements.push({
        type: type,
        id: link.id || null,
        text: (link.textContent || href).trim().slice(0, 100) || null
      });
    }

    try {
      showScanBanner();
      var payload = JSON.stringify({ vid: vid, elements: elements });
      var xhr = new XMLHttpRequest();
      xhr.open("POST", SCAN_URL, true);
      xhr.withCredentials = false;
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) completeScanBanner();
        else failScanBanner();
      };
      xhr.onerror = function() { failScanBanner(); };
      xhr.send(payload);
    } catch(e) { failScanBanner(); }
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
