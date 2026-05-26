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
  var _SL = {
    testId: ${JSON.stringify(testId)},
    variantId: ${JSON.stringify(variantId)},
    visitorHash: ${JSON.stringify(visitorHash)},
    apiUrl: ${JSON.stringify(appUrl)},
    goals: ${goalsJson},
    _sent: {},
    track: function(type, goalId) {
      var key = type + ':' + (goalId || '');
      if (this._sent[key]) return;
      this._sent[key] = true;
      var self = this;
      var payload = JSON.stringify({
        testId: self.testId,
        variantId: self.variantId,
        goalId: goalId || null,
        visitorHash: self.visitorHash,
        type: type
      });
      if (navigator.sendBeacon) {
        try {
          var blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon(self.apiUrl + '/api/event', blob);
          return;
        } catch(e) {}
      }
      fetch(self.apiUrl + '/api/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }).catch(function() {});
    }
  };

  // Auto-track pageview
  _SL.track('pageview');

  // Wire up conversion goals
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
    if (urlGoals.length > 0) {
      checkUrlGoals();
      function wrapHistory(method) {
        var orig = history[method];
        history[method] = function() { orig.apply(this, arguments); checkUrlGoals(); };
      }
      try { wrapHistory('pushState'); wrapHistory('replaceState'); } catch(e) {}
      window.addEventListener('popstate', function() { checkUrlGoals(); });
      window.addEventListener('hashchange', function() { checkUrlGoals(); });
    }

    // Resolve an id:/text:/legacy-CSS selector to a list of DOM elements
    function resolveElements(selector, type) {
      if (!selector) {
        if (type === 'form_submit') return Array.from(document.querySelectorAll('form'));
        return [];
      }
      if (selector.indexOf('id:') === 0) {
        var byId = document.getElementById(selector.slice(3));
        return byId ? [byId] : [];
      }
      if (selector.indexOf('text:') === 0) {
        var needle = selector.slice(5).toLowerCase();
        var candidates = document.querySelectorAll("button, [role='button'], [role='switch'], input[type='submit'], input[type='button'], input[type='checkbox'], a[href]");
        var matches = [];
        for (var ci = 0; ci < candidates.length; ci++) {
          var c = candidates[ci];
          var cText = (c.textContent || c.value || c.getAttribute('aria-label') || '').trim().toLowerCase();
          if (!c.id && cText === needle) matches.push(c);
        }
        return matches;
      }
      // Legacy CSS selector (e.g. #my-form, .cta-btn)
      return Array.from(document.querySelectorAll(selector));
    }

    _SL.goals.forEach(function(goal) {
      if (goal.type === 'url_reached') {
        // handled above
      } else if (goal.type === 'form_submit') {
        resolveElements(goal.selector, 'form_submit').forEach(function(form) {
          form.addEventListener('submit', function() {
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGoals);
  } else {
    initGoals();
  }

  window.SplitLab = _SL;
})();
</script>`;
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
  function runScan() {
    var elements = [];
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      elements.push({ type: 'form', id: forms[i].id || null, text: null });
    }
    var buttons = document.querySelectorAll("button, [role='button'], [role='switch'], input[type='submit'], input[type='button']");
    for (var j = 0; j < buttons.length; j++) {
      var btn = buttons[j];
      elements.push({ type: 'button', id: btn.id || null, text: (btn.textContent || btn.value || '').trim().slice(0, 100) || null });
    }
    var checkboxes = document.querySelectorAll("input[type='checkbox']");
    for (var m = 0; m < checkboxes.length; m++) {
      var cb = checkboxes[m];
      elements.push({ type: 'toggle', id: cb.id || null, text: cb.getAttribute('aria-label') || cb.name || null });
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
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', scanUrl, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300 && scanBanner) {
          scanBanner.innerHTML = '<span style="font-size:15px">✓</span><span>Scan completed</span>';
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
