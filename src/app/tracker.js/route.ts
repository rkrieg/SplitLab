import { NextResponse } from 'next/server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://trysplitlab.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function GET() {
  const script = buildTrackerScript(APP_URL);
  return new NextResponse(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      ...CORS_HEADERS,
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: CORS_HEADERS });
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
    // Track all form submissions
    document.querySelectorAll("form").forEach(function(form) {
      form.addEventListener("submit", function() {
        track("conversion", null, { trigger: "form_submit" });
      });
    });

    // Track CTA button clicks (buttons not inside forms)
    document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']").forEach(function(el) {
      if (el.closest("form")) return;
      el.addEventListener("click", function() {
        track("conversion", null, { trigger: "button_click", text: (el.textContent || "").trim().slice(0, 50) });
      });
    });

    // Track CTA link clicks (links styled as buttons)
    document.querySelectorAll("a").forEach(function(el) {
      var href = el.getAttribute("href") || "";
      if (!href || href.charAt(0) === "#" || href.indexOf("javascript:") === 0) return;

      // Track tel: links as call clicks
      if (href.indexOf("tel:") === 0) {
        el.addEventListener("click", function() {
          track("conversion", null, { trigger: "call_click" });
        });
        return;
      }

      // Track links that look like CTA buttons
      var cls = (el.className || "").toLowerCase();
      if (cls.match(/btn|button|cta/) || el.getAttribute("role") === "button") {
        el.addEventListener("click", function() {
          track("conversion", null, { trigger: "button_click", text: (el.textContent || "").trim().slice(0, 50) });
        });
      }
    });
  }

  // ─── Detection: resolve context from URL params or localStorage ────────────

  function detect(callback) {
    var params = new URLSearchParams(window.location.search);

    // Method 1: Full params from SplitLab redirect (?sl_tid, ?sl_vid, ?sl_vh)
    var tid = params.get("sl_tid");
    var vid = params.get("sl_vid");
    var vh  = params.get("sl_vh");
    if (tid && vid && vh) {
      cleanUrl(["sl_tid", "sl_vid", "sl_vh"]);
      return callback({ tid: tid, vid: vid, vh: vh });
    }

    // Method 2: Variant ID only (?sl_vid=xxx) — resolve test ID via API
    if (vid && !tid) {
      cleanUrl(["sl_vid"]);
      var xhr = new XMLHttpRequest();
      xhr.open("GET", RESOLVE_URL + "?vid=" + encodeURIComponent(vid), true);
      xhr.onload = function() {
        try {
          var data = JSON.parse(xhr.responseText);
          if (data.testId) callback({ tid: data.testId, vid: data.variantId, vh: vh || uuid() });
          else callback(load());
        } catch(e) { callback(load()); }
      };
      xhr.onerror = function() { callback(load()); };
      xhr.send();
      return;
    }

    // Method 3: Shorthand (?sl_variant=xxx)
    var variantId = params.get("sl_variant");
    if (variantId) {
      cleanUrl(["sl_variant"]);
      var xhr2 = new XMLHttpRequest();
      xhr2.open("GET", RESOLVE_URL + "?vid=" + encodeURIComponent(variantId), true);
      xhr2.onload = function() {
        try {
          var data = JSON.parse(xhr2.responseText);
          if (data.testId) callback({ tid: data.testId, vid: data.variantId, vh: uuid() });
          else callback(load());
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

    function onReady() { wireAutoConversions(); }
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
