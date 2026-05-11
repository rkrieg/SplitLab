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
      // Use sendBeacon when available (survives page navigations)
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
  function checkUrlGoals(href) {
    var url = href || window.location.href;
    _SL.goals.forEach(function(goal) {
      if (goal.type !== 'url_reached' || !goal.urlPattern) return;
      try {
        // Match against full URL or just the pathname+search
        var pattern = new RegExp(goal.urlPattern, 'i');
        if (pattern.test(url) || pattern.test(window.location.pathname + window.location.search)) {
          _SL.track('conversion', goal.id);
        }
      } catch(e) {}
    });
  }

  function initGoals() {
    var urlGoals = _SL.goals.filter(function(g) { return g.type === 'url_reached'; });

    // ── url_reached ──────────────────────────────────────────────────────────
    if (urlGoals.length > 0) {
      // Check immediately on load
      checkUrlGoals();

      // Intercept history.pushState / replaceState (SPA navigation)
      function wrapHistory(method) {
        var orig = history[method];
        history[method] = function() {
          orig.apply(this, arguments);
          checkUrlGoals();
        };
      }
      try { wrapHistory('pushState'); wrapHistory('replaceState'); } catch(e) {}

      // Browser back/forward + hash changes
      window.addEventListener('popstate', function() { checkUrlGoals(); });
      window.addEventListener('hashchange', function() { checkUrlGoals(); });

      // Proxy-mode iframe: listen for inner-page navigation.
      // We can't read the cross-origin iframe's URL, but we CAN check the
      // top-frame href in case allow-top-navigation caused the outer URL to
      // change, and also try to read same-origin iframes.
      document.querySelectorAll('iframe').forEach(function(iframe) {
        iframe.addEventListener('load', function() {
          // Re-check the outer page URL (catches top-frame navigations)
          checkUrlGoals();
          // Attempt to read same-origin iframe URL (throws for cross-origin)
          try {
            var innerHref = iframe.contentWindow && iframe.contentWindow.location.href;
            if (innerHref) checkUrlGoals(innerHref);
          } catch(e) { /* cross-origin — cannot read URL */ }
        });
      });
    }

    // ── form_submit ──────────────────────────────────────────────────────────
    _SL.goals.forEach(function(goal) {
      if (goal.type === 'form_submit') {
        var forms = goal.selector
          ? document.querySelectorAll(goal.selector)
          : document.querySelectorAll('form');
        forms.forEach(function(form) {
          form.addEventListener('submit', function() {
            _SL.track('conversion', goal.id);
          });
        });

      // ── button_click ───────────────────────────────────────────────────────
      } else if (goal.type === 'button_click') {
        if (goal.selector) {
          document.querySelectorAll(goal.selector).forEach(function(el) {
            el.addEventListener('click', function() {
              _SL.track('conversion', goal.id);
            });
          });
        }

      // ── call_click ─────────────────────────────────────────────────────────
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
