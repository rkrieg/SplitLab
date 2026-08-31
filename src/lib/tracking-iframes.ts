import { buildTrackingParamsJs } from './tracking-params';

/**
 * Forward the visitor's ad params onto EMBEDDED WIDGETS (Calendly, HubSpot
 * meetings, Typeform) — the one outbound path the cross-domain linker never
 * covered.
 *
 * THE GAP THIS CLOSES
 * decorate() in tracking.ts / tracker.js catches links, forms, window.open and
 * (where the Navigation API exists) location.href. All four are NAVIGATIONS. An
 * embedded widget is not: the vendor's script builds an <iframe> and sets its
 * src, no click event and no navigation, so nothing we hook ever sees the URL.
 * A visitor who arrived on utm_source=meta booked a call through the embed and
 * the booking arrived with no attribution at all. Calendly and friends read
 * utm_* off their own embed URL natively — we only ever had to put the params
 * there.
 *
 * WHY THE HOOK, NOT A SCAN
 * A scan has to pick a moment. Before load misses every widget, because the
 * iframe does not exist yet — it is built on click, or by a vendor script that
 * runs whenever it runs. After load means the iframe already fetched the
 * undecorated URL, and re-pointing it is a visible flash, a second request, and
 * (if the visitor is mid-booking) a wiped form. Hooking the moment src is
 * ASSIGNED has no moment to pick: dynamic widgets are decorated before the
 * browser ever fetches them.
 *
 * The MutationObserver is the fallback for the one case the setter cannot see:
 * an <iframe src="..."> written literally into the page's HTML, where the
 * parser sets the attribute directly. That one does cost a second request. It
 * is the rarer shape and the only case where "let it load twice" applies.
 *
 * WHERE IT RUNS
 *  - <head> of every SplitLab-served HTML page (serve route headScripts), so it
 *    is installed before the body — and therefore before any widget script —
 *    is parsed.
 *  - tracker.js, for redirect-mode destination pages we do not serve.
 * Whichever lands first claims window.__SL_IFRAME_HOOK__; the other stands
 * down, so a page carrying both is hooked exactly once.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  - No sl_tid/sl_vid/sl_vh. Those exist so tracker.js on a DESTINATION page can
 *    rebuild variant context; a third-party widget does not run tracker.js, and
 *    an sl_vid inside an embed would pin a variant for a frame that never
 *    reports anything. Ad params only.
 *  - Same-origin iframes are left alone. Every widget this exists for is
 *    cross-origin, and same-origin iframes are far more likely to be a page's
 *    own plumbing.
 *  - It never touches an iframe twice on the observer path. Params can change
 *    mid-session (an SPA pushing a new URL); re-pointing a long-lived embed
 *    would reload a booking the visitor was halfway through filling in.
 *
 * WHAT IS STILL NOT COVERED ANYWHERE (known, not a TODO)
 *  1. A button doing window.location.href = 'https://other-site.com'. Caught
 *     only by the Navigation API in watchNavigations(), which is Chrome/Edge
 *     102+, Safari 26.2+, Firefox 147+ — about 87% of traffic. The location
 *     object cannot be patched, so the remaining 13% is a browser-support
 *     ceiling, not unfinished work. It can never reach 100%.
 *  2. tracker.js's first second on a redirect-mode page. Its click listeners
 *     are registered from start(), which waits on /api/resolve, so a visitor
 *     who clicks out inside that window leaves undecorated. The iframe hook
 *     below is deliberately NOT in that path — it installs at parse time — so
 *     this costs embeds nothing.
 *
 * KNOWN: THIS APPLIES TO EVERY CROSS-ORIGIN IFRAME, NOT JUST BOOKING WIDGETS
 * A Stripe card field and a captcha frame are also iframes pointing at another
 * origin, so they are decorated too. Verified harmless — they read the params
 * they know by name and ignore the rest — and every widget checked in
 * scripts/verify-tracking-browser.mjs loads normally with them attached.
 *
 * The rule stays generic on purpose. A "skip Stripe, skip reCAPTCHA" denylist
 * rots the moment a vendor changes domain or a client adds one nobody listed,
 * and it is exactly the per-vendor patching this codebase avoids elsewhere.
 *
 * NOTHING HAS TO BE CONFIGURED. The default is "every cross-origin iframe gets
 * the params", which is the behaviour we want; data-sl-no-params is an
 * extinguisher, not a setting — nobody needs to predict in advance where params
 * are wanted. If a specific frame ever misbehaves, either escape works without a
 * deploy: mark that iframe (or any element wrapping it) data-sl-no-params, or
 * turn off tests.forward_url_params to disable forwarding for the whole test.
 *
 * KNOWN: A STATIC <iframe src> COSTS ONE EXTRA REQUEST
 * The parser has already begun fetching by the time the observer repoints it,
 * so the vendor sees the bare URL and then the decorated one. Measured at
 * exactly two requests, never a loop (asserted in the browser suite). It only
 * affects hand-written embeds: Calendly, HubSpot meetings and Typeform all
 * build their iframe from a script, which the src hook catches before the first
 * request. Fixing it would mean rewriting the stored HTML server-side, which
 * puts an HTML re-serialise on the path of every served page — a far worse
 * trade for a case the major vendors do not hit.
 */

export interface IframeHookOptions {
  /**
   * JS expression, evaluated at decoration time, that is true when this page
   * must not be mutated (scan / preview / over-cap). Matches the mute rule the
   * rest of the linker already follows — scan mode inspects the page to build
   * goals, so nothing may rewrite it underneath.
   */
  mutedExpr: string;
  /**
   * JS expression, evaluated at decoration time, that is true when UTM
   * forwarding is on for this test (tests.forward_url_params).
   */
  forwardExpr: string;
  /** Indentation prefix for every emitted line. Cosmetic only. */
  indent?: string;
}

/**
 * The hook itself, as a bare block. Assumes `trackingParams()` is already in
 * scope — so it can be dropped straight into tracker.js's IIFE, which has one.
 * For a standalone context use buildIframeHeadScript(), which supplies its own.
 */
export function buildIframeHookBody(opts: IframeHookOptions): string {
  const { mutedExpr, forwardExpr, indent = '  ' } = opts;

  const body = `
// ─── Embedded-widget params (generated from src/lib/tracking-iframes.ts) ────
(function() {
  try {
    // First hook on the page wins. The head script and a hardcoded tracker.js
    // tag can both be present; two hooks would each wrap the other's src setter
    // and run two observers for one page.
    if (window.__SL_IFRAME_HOOK__) return;
    window.__SL_IFRAME_HOOK__ = true;
  } catch(e) { return; }

  // Same ceiling decorate() uses. An over-long URL drops the extras rather than
  // risking a truncated request.
  var MAX_IFRAME_URL = 2000;
  // Observer-path bookkeeping only — see "never touches an iframe twice" above.
  var SEEN = (typeof WeakSet === 'function') ? new WeakSet() : null;

  function slMuted() { try { return !!(${mutedExpr}); } catch(e) { return false; } }
  function slForward() { try { return !!(${forwardExpr}); } catch(e) { return false; } }
  function slActive() { return !slMuted() && slForward(); }

  // Explicit opt-out, on the iframe or anything above it. The escape hatch for
  // a frame that must receive exactly the URL its vendor built.
  function optedOut(el) {
    try {
      if (!el) return false;
      if (el.hasAttribute && el.hasAttribute('data-sl-no-params')) return true;
      if (el.closest && el.closest('[data-sl-no-params]')) return true;
    } catch(e) {}
    return false;
  }

  // Returns the decorated URL, or null for "leave this exactly as it is".
  // Null is the answer for every skip case, so callers never write back a value
  // they did not change.
  function decorateIframeUrl(url, base) {
    try {
      if (!url) return null;
      var u = new URL(String(url), base || window.location.href);
      // about:blank, srcdoc, javascript:, data: — nothing to attribute.
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (u.hostname === window.location.hostname) return null;
      var p = trackingParams(), k;
      var len = u.toString().length;
      var added = false;
      for (k in p) {
        if (!p.hasOwnProperty(k)) continue;
        // Explicit beats inherited — a vendor URL that already names a param
        // keeps its own value; the rest are still appended.
        if (u.searchParams.has(k)) continue;
        var cost = k.length + p[k].length + 2;
        if (len + cost > MAX_IFRAME_URL) break;
        u.searchParams.set(k, p[k]);
        len += cost;
        added = true;
      }
      if (!added) return null;
      return u.toString();
    } catch(e) { return null; }
  }

  function decorateFor(el, url) {
    if (!slActive()) return null;
    if (optedOut(el)) return null;
    var base;
    try { base = el && el.baseURI; } catch(e) {}
    return decorateIframeUrl(url, base);
  }

  // ── Hook 1: iframe.src = '...' — how every widget SDK builds its frame ─────
  // Runs BEFORE the assignment reaches the browser, so there is no first
  // request to the undecorated URL and nothing to reload.
  try {
    var proto = window.HTMLIFrameElement && window.HTMLIFrameElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'src');
    if (desc && desc.set && desc.get && desc.configurable) {
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function() { return desc.get.call(this); },
        set: function(v) {
          var dec = null;
          try { dec = decorateFor(this, v); } catch(e) {}
          desc.set.call(this, dec || v);
        }
      });
    }
  } catch(e) {}

  // ── Hook 2: iframe.setAttribute('src', '...') — the other way SDKs do it ───
  // Defined on HTMLIFrameElement.prototype, which shadows Element's. Patching
  // Element.prototype.setAttribute would put this on the hot path of every
  // attribute write on the page.
  try {
    var iproto = window.HTMLIFrameElement && window.HTMLIFrameElement.prototype;
    if (iproto && !iproto.__slSetAttrPatched) {
      var origSet = iproto.setAttribute || (window.Element && window.Element.prototype.setAttribute);
      if (origSet) {
        iproto.setAttribute = function(name, value) {
          try {
            if (name && String(name).toLowerCase() === 'src') {
              var dec = decorateFor(this, value);
              if (dec) value = dec;
            }
          } catch(e) {}
          return origSet.call(this, name, value);
        };
        iproto.__slSetAttrPatched = true;
      }
    }
  } catch(e) {}

  // ── Hook 3: <iframe src="..."> written into the HTML ──────────────────────
  // The parser sets the attribute without going through either hook above, so
  // this is the one path that repoints an iframe after its first request. The
  // observer fires as a microtask on insertion, long before anyone could have
  // interacted with the frame.
  function fixIframe(el) {
    try {
      if (!el) return;
      // Mark first, unconditionally: at most one observer-driven write per
      // iframe, whatever happens below.
      if (SEEN) { if (SEEN.has(el)) return; SEEN.add(el); }
      else { if (el.__slIframeSeen) return; el.__slIframeSeen = true; }
      var cur = el.getAttribute && el.getAttribute('src');
      if (!cur) return;
      var dec = decorateFor(el, cur);
      // Goes back through Hook 2, which finds every param already present and
      // returns null — so this writes exactly once.
      if (dec) el.setAttribute('src', dec);
    } catch(e) {}
  }

  function scanNode(n) {
    try {
      if (!n || n.nodeType !== 1) return;
      if (n.tagName === 'IFRAME') fixIframe(n);
      if (!n.getElementsByTagName) return;
      var list = n.getElementsByTagName('iframe');
      for (var i = 0; i < list.length; i++) fixIframe(list[i]);
    } catch(e) {}
  }

  try {
    // Read off window rather than relying on the bare global — the snippet also
    // runs inside wrappers that do not put every DOM constructor on the scope
    // chain, and a bare reference throws there instead of degrading.
    var MO = window.MutationObserver;
    if (MO) {
      var mo = new MO(function(muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          if (!added || !added.length) continue;
          for (var j = 0; j < added.length; j++) scanNode(added[j]);
        }
      });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    }
  } catch(e) {}

  // Catches anything already parsed when this runs — which is nothing when the
  // hook is in <head>, but is the whole page when tracker.js is tagged late.
  try { scanNode(document.documentElement); } catch(e) {}
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        try { scanNode(document.documentElement); } catch(e) {}
      });
    }
  } catch(e) {}
})();`;

  return body
    .split('\n')
    .map((line) => (line.length ? indent + line : line))
    .join('\n')
    .trim();
}

/**
 * Standalone <script> for the <head> of a served HTML page.
 *
 * Carries its own copy of the param logic because it runs in <head>, well ahead
 * of the tracking snippet at body end — the whole point is to be installed
 * before any widget script. It also calls captureParamsFromUrl() itself: the
 * snippet's call has not happened yet, and without it a visitor arriving on a
 * fresh utm_campaign would have the hook read last week's stored set. Both
 * calls write the same value from the same URL, so running twice is a no-op.
 */
export function buildIframeHeadScript(
  customParamNames: string[] = [],
  /** tests.forward_url_params — the per-test kill switch. */
  forwardParams: boolean = true,
  /**
   * Mirrors buildTrackingSnippet's muteMode. 'preview' is sticky per tab via
   * sessionStorage, exactly as the snippet makes it, because page 2 of a
   * preview tab no longer carries ?sl_preview.
   */
  muteMode: '' | 'preview' | 'cap' = ''
): string {
  const paramsJs = buildTrackingParamsJs({
    customParamsExpr: JSON.stringify(customParamNames),
    indent: '  ',
  });

  const hook = buildIframeHookBody({
    mutedExpr: 'slPageMuted()',
    forwardExpr: JSON.stringify(forwardParams),
    indent: '  ',
  });

  return `<script>
(function() {
  "use strict";
  if (window.__SL_IFRAME_HOOK__) return;

  ${paramsJs}

  // Own capture: this runs before the body snippet's. See the note above.
  captureParamsFromUrl();

  function slPageMuted() {
    try {
      var sp = new URLSearchParams(window.location.search);
      if (sp.get('sl_scan') === '1') return true;
      if (sp.get('sl_preview') === '1') return true;
      if (${JSON.stringify(muteMode === 'cap' || muteMode === 'preview')}) return true;
      try { if (sessionStorage.getItem('__sl_preview') === '1') return true; } catch(e) {}
    } catch(e) {}
    return false;
  }

  ${hook}
})();
</script>`;
}
