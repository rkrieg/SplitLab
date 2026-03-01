import { NextResponse } from 'next/server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://trysplitlab.com';

export async function GET() {
  const script = buildTrackerScript(APP_URL);
  return new NextResponse(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function buildTrackerScript(appUrl: string): string {
  return `/**
 * SplitLab Conversion Tracker v1.0
 * Lightweight, zero-dependency tracking snippet for external websites.
 * Include on any page: <script src="${appUrl}/tracker.js"></script>
 */
(function() {
  "use strict";

  var API_BASE = ${JSON.stringify(appUrl)};
  var EVENT_URL = API_BASE + "/api/event";
  var RESOLVE_URL = API_BASE + "/api/resolve";
  var STORAGE_KEY = "sl_tracking";
  var _sent = {};
  var _ready = false;
  var _queue = [];
  var _ctx = null; // { tid, vid, vh }
  var _goals = [];

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
        navigator.sendBeacon(EVENT_URL, body);
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

    // Method 2: Variant-only shorthand (?sl_variant=variantId)
    var variantId = params.get("sl_variant");
    if (variantId) {
      cleanUrl(["sl_variant"]);
      // Resolve test ID from variant ID via API
      var xhr = new XMLHttpRequest();
      xhr.open("GET", RESOLVE_URL + "?vid=" + encodeURIComponent(variantId), true);
      xhr.onload = function() {
        try {
          var data = JSON.parse(xhr.responseText);
          if (data.testId) {
            callback({ tid: data.testId, vid: data.variantId, vh: uuid() });
          } else {
            callback(load()); // Fallback to localStorage
          }
        } catch(e) { callback(load()); }
      };
      xhr.onerror = function() { callback(load()); };
      xhr.send();
      return;
    }

    // Method 3: localStorage (returning visitor)
    callback(load());
  }

  // ─── Core tracking ─────────────────────────────────────────────────────────

  function track(type, goalId, meta) {
    if (!_ctx) return;
    var key = type + ":" + (goalId || "");
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

  // ─── Goal auto-wiring ─────────────────────────────────────────────────────

  function wireGoals() {
    _goals.forEach(function(goal) {
      switch (goal.type) {
        case "form_submit":
          var forms = goal.selector
            ? document.querySelectorAll(goal.selector)
            : document.querySelectorAll("form");
          forms.forEach(function(form) {
            form.addEventListener("submit", function() {
              track("conversion", goal.id || null, { trigger: "form_submit", selector: goal.selector || "*" });
            });
          });
          break;

        case "button_click":
          if (goal.selector) {
            document.querySelectorAll(goal.selector).forEach(function(el) {
              el.addEventListener("click", function() {
                track("conversion", goal.id || null, { trigger: "button_click", selector: goal.selector });
              });
            });
          }
          break;

        case "url_reached":
          if (goal.urlPattern) {
            try {
              if (new RegExp(goal.urlPattern).test(window.location.href)) {
                track("conversion", goal.id || null, { trigger: "url_reached", pattern: goal.urlPattern });
              }
            } catch(e) {}
          }
          break;

        case "call_click":
          document.querySelectorAll('a[href^="tel:"]').forEach(function(el) {
            el.addEventListener("click", function() {
              track("conversion", goal.id || null, { trigger: "call_click" });
            });
          });
          break;
      }
    });
  }

  // ─── Initialization ────────────────────────────────────────────────────────

  function boot(ctx) {
    _ctx = ctx;
    if (!_ctx) return;
    store(_ctx);
    _ready = true;

    // Flush any queued calls
    _queue.forEach(function(fn) { fn(); });
    _queue = [];

    // Auto-wire goals once DOM is ready
    function onReady() { wireGoals(); }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onReady);
    } else {
      onReady();
    }
  }

  // ─── Public API: window.SplitLab ──────────────────────────────────────────

  window.SplitLab = {
    /**
     * Manually initialize with known IDs (used by pre-filled snippets).
     * SplitLab.init({ testId: "...", variantId: "..." })
     */
    init: function(opts) {
      if (!opts) return;
      var ctx = {
        tid: opts.testId || opts.tid,
        vid: opts.variantId || opts.vid,
        vh:  opts.visitorHash || opts.vh || load()?.vh || uuid()
      };
      if (ctx.tid && ctx.vid) {
        boot(ctx);
      }
    },

    /**
     * Register conversion goals for auto-wiring.
     * SplitLab.goals([
     *   { type: "form_submit", selector: "#my-form", id: "goal-uuid" },
     *   { type: "button_click", selector: ".cta-btn" },
     *   { type: "url_reached", urlPattern: "/thank-you" },
     *   { type: "call_click" }
     * ])
     */
    goals: function(goalList) {
      _goals = goalList || [];
      if (_ready) {
        // Re-wire if already booted
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", wireGoals);
        } else {
          wireGoals();
        }
      }
    },

    /**
     * Fire a tracking event manually.
     * SplitLab.track("conversion")
     * SplitLab.track("conversion", "goal-uuid")
     * SplitLab.track("conversion", null, { custom: "data" })
     */
    track: function(type, goalId, meta) {
      if (_ready) {
        track(type || "conversion", goalId, meta);
      } else {
        _queue.push(function() { track(type || "conversion", goalId, meta); });
      }
    },

    /** Get the current tracking context (for debugging). */
    getContext: function() { return _ctx; },

    /** Check if tracking is active. */
    isActive: function() { return _ready; }
  };

  // ─── Auto-detect and boot ─────────────────────────────────────────────────
  detect(boot);

})();
`;
}
