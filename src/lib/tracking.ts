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

  // Auto-track pageview (skip on scan requests — sl_scan=1 means dashboard goal setup)
  if (!_isScan) {
    _SL.track('pageview');
    saveCtx();
  }

  // ─── Form lead capture helpers ──────────────────────────────────────────────

  // Accumulates field values across stepper steps so submit captures all steps' data
  var _accumulatedFormData = {};
  var _leadSent = false;
  // Form (or null) containing the last-clicked submit-style button — scopes the
  // validity check for JS-driven submits so unrelated forms can never block a lead
  var _lastClickScopeForm = null;

  function isFieldVisible(el) {
    try {
      if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true });
      // Legacy fallback: offsetParent is null for display:none but also for
      // position:fixed (visible popups) — treat fixed as visible; unsure → visible
      if (el.offsetParent !== null) return true;
      var st = window.getComputedStyle ? getComputedStyle(el) : null;
      return st ? (st.position === 'fixed' && st.display !== 'none') : true;
    } catch(e) { return true; }
  }

  // True when every visible field passes the browser's HTML constraint validation
  // (required, type=email, pattern…). Reads validity.valid directly so no invalid
  // events fire on the host page. Hidden fields (other stepper steps, conditional
  // fields) never block. With no scopeForm, fields inside any <form> are ignored —
  // they belong to real forms whose own submit path governs them. Fails open: any
  // uncertainty means send anyway (worst case = pre-gate behavior).
  function fieldsLookValid(scopeForm) {
    try {
      // Deliberately no novalidate exemption: builders like Unbounce set novalidate
      // at runtime and run their own validation off the same required/pattern
      // attributes — validity.valid is still computed per-element regardless.
      var els = scopeForm ? scopeForm.elements : document.querySelectorAll('input, select, textarea');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el || el.disabled) continue;
        var t = (el.type || '').toLowerCase();
        if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'file') continue;
        if (!scopeForm && el.form) continue;
        if (!(el.willValidate && el.validity && !el.validity.valid)) continue;
        if (!isFieldVisible(el)) continue;
        return false;
      }
    } catch(e) {}
    return true;
  }

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
        utm: utm,
        // Read at submit time, before the site navigates to any thank-you page,
        // so this is the page the form was actually on.
        pageUrl: window.location.href,
        pageTitle: document.title || ''
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
    // Incomplete/invalid form → the site will reject this attempt; skip the send
    // and leave _leadSent unlocked so the corrected re-submit still captures.
    if (form && form.elements && !fieldsLookValid(form)) return;
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
    if (!fieldsLookValid(_lastClickScopeForm)) return;
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
      captureFormLead(e.target);
    }, true);

    // Global button click — snapshot fields for stepper + submit-keyword detection
    document.addEventListener('click', function(e) {
      var el = e.target;
      if (!el || !el.closest) return;
      var btn = el.closest("button, [role='button'], input[type='submit'], input[type='button']");
      if (!btn) return;
      _lastClickScopeForm = btn.form || (btn.closest ? btn.closest('form') : null);
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
 * Build a favicon link tag for the client's logo.
 */
export function buildFaviconTag(logoUrl: string): string {
  const safeUrl = logoUrl.replace(/"/g, '&quot;');
  return `<link rel="icon" href="${safeUrl}">`;
}

/**
 * Remove favicon link tags (rel="icon" / rel="shortcut icon") from HTML so an
 * injected client logo always wins. apple-touch-icon is left alone — it's for
 * home-screen shortcuts, not the browser tab.
 */
export function stripFaviconTags(html: string): string {
  return html.replace(/<link\b[^>]*\brel\s*=\s*["']?(?:shortcut\s+)?icon\b[^>]*>/gi, '');
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
