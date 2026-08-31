/**
 * Real behaviour tests for the embedded-widget UTM forwarding.
 *
 * Two jobs, and the first matters more than the second:
 *
 * 1. PROVE THE REFACTOR CHANGED NOTHING. The param-detection block used to be
 *    hand-copied into src/lib/tracking.ts and src/app/tracker.js/route.ts; both
 *    now generate it from src/lib/tracking-params.ts. Rather than diff text —
 *    which cannot tell a reworded comment from a changed rule — this runs the
 *    PRE-CHANGE copies (pasted verbatim below, lifted from git) and the freshly
 *    generated ones side by side in identical sandboxes and asserts they answer
 *    every question the same way. That is what makes the swap safe to ship.
 *
 * 2. Test the new iframe hook: the src setter, setAttribute, and the
 *    MutationObserver fallback, plus every skip case (same-origin, opted out,
 *    muted, forwarding off, no params to forward).
 *
 * The DOM shim below is deliberately small and hand-written — enough to model
 * HTMLIFrameElement's prototype chain, which is the thing the hook actually
 * reaches into. It is not a browser, so it proves the logic, not the browser
 * integration; the vendor-embed cases still want one live check each.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-tracking-iframes');
const stageDir = join(outDir, 'src');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// tsc is given copies with the `@/` alias rewritten to a sibling path: the alias
// lives in tsconfig paths and resolving it here would drag the whole app in.
for (const f of ['tracking-params.ts', 'tracking-iframes.ts']) {
  writeFileSync(
    join(stageDir, f),
    readFileSync(join(repoRoot, 'src', 'lib', f), 'utf8').replace(/@\/lib\//g, './'),
  );
}

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    join(stageDir, 'tracking-params.ts'),
    join(stageDir, 'tracking-iframes.ts'),
    '--outDir', join(outDir, 'js'),
    '--target', 'es2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--skipLibCheck',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const { buildTrackingParamsJs } = require(join(outDir, 'js', 'tracking-params.js'));
const { buildIframeHookBody, buildIframeHeadScript } = require(join(outDir, 'js', 'tracking-iframes.js'));

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`OK: ${name}`);
  else {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── DOM shim ─────────────────────────────────────────────────────────────────
// Models only what the hook touches. The one detail that has to be right is
// that HTMLIFrameElement.prototype has its own `src` accessor and inherits
// setAttribute from Element.prototype — the hook overrides the first and
// shadows the second, and a shim that flattened them would test nothing.
function makeDom(locationHref) {
  const observers = [];

  class FakeElement {
    constructor(tag) {
      this.tagName = tag;
      this.nodeType = 1;
      this._attrs = {};
      this.childNodes = [];
      this.parentNode = null;
    }
    get baseURI() { return locationHref; }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; }
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); }
    setAttribute(n, v) { this._attrs[n] = String(v); }
    removeAttribute(n) { delete this._attrs[n]; }
    closest(sel) {
      const attr = sel.replace(/^\[|\]$/g, '');
      let node = this;
      while (node) {
        if (node.hasAttribute && node.hasAttribute(attr)) return node;
        node = node.parentNode;
      }
      return null;
    }
    getElementsByTagName(tag) {
      const want = tag.toUpperCase();
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.tagName === want) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      for (const cb of observers) cb([{ addedNodes: [child] }]);
      return child;
    }
  }

  class FakeIframe extends FakeElement {
    constructor() { super('IFRAME'); }
  }
  // Own accessor on the prototype, writing the attribute store directly rather
  // than routing through setAttribute — so the two hooks are provably tested
  // one at a time instead of one masking the other.
  Object.defineProperty(FakeIframe.prototype, 'src', {
    configurable: true,
    enumerable: true,
    get() { return this._attrs.src || ''; },
    set(v) { this._attrs.src = String(v); },
  });

  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; }
    observe() { observers.push(this.cb); }
    disconnect() {}
  }

  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sessionStore = new Map();

  const url = new URL(locationHref);
  const documentElement = new FakeElement('HTML');
  const document = {
    documentElement,
    readyState: 'loading',
    addEventListener() {},
    createElement: (t) => (t.toLowerCase() === 'iframe' ? new FakeIframe() : new FakeElement(t.toUpperCase())),
  };

  const win = {
    HTMLIFrameElement: FakeIframe,
    Element: FakeElement,
    MutationObserver: FakeMutationObserver,
    location: { href: locationHref, search: url.search, hostname: url.hostname },
    document,
    localStorage: storage,
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => sessionStore.set(k, String(v)),
    },
  };

  const sandbox = {
    window: win,
    document,
    localStorage: storage,
    sessionStorage: win.sessionStorage,
    URL,
    URLSearchParams,
    JSON,
    Date,
    Object,
    Array,
    String,
    WeakSet,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, win, document, FakeIframe, FakeElement };
}

function run(dom, code) {
  return vm.runInContext(`(function(){ "use strict";\n${code}\n})()`, dom.sandbox);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. EQUIVALENCE — the generated param block vs the copy it replaced
// ═════════════════════════════════════════════════════════════════════════════

const NAMES = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'UTM_SOURCE',
  'hsa_grp', 'hsa_ad', 'gclid', 'fbclid', 'fbc_id', 'fbp', 'msclkid', 'ttclid',
  'li_fat_id', 'twclid', 'dclid', 'wbraid', 'gbraid', 'epik', 'sccid', 'irclickid',
  'h_ad_id', 'ad_id', 'adset_id', 'campaign_id', 'creative_id', 'placement_id',
  'sl_vid', 'sl_tid', 'sl_vh', 'sl_scan', 'user_id', 'session_id', 'order_id',
  'ref', 'q', 'page', '', 'constructor', 'toString', 'affiliate_id',
];

const QUERIES = [
  '',
  '?utm_source=meta&utm_campaign=spring&gclid=abc',
  '?user_id=99&order_id=1&utm_medium=cpc',
  '?sl_vid=x&sl_tid=y&utm_source=google',
  `?utm_term=${'z'.repeat(700)}`,
  `?${'k'.repeat(120)}=v&utm_source=ok`,
  '?utm_source=&utm_medium=cpc',
  '?affiliate_id=partner7&utm_source=news',
];

// Probe suite. Runs inside the sandbox so both copies are exercised through the
// same entry points a real page would use.
const PROBE = `
  var results = { is: [], collect: [], split: [], roundTrip: null };
  for (var i = 0; i < NAMES.length; i++) results.is.push(!!isTrackingParam(NAMES[i]));
  for (var j = 0; j < QUERIES.length; j++) {
    results.collect.push(collectTrackingParams(new URLSearchParams(QUERIES[j])));
  }
  results.split.push(splitTrackingParams({
    utm_source: 'a', gclid: 'b', hsa_grp: 'c', ad_id: 'd', utm_content: 'e'
  }));
  // capture -> load -> overlay, the path a two-page visit actually takes
  saveParams({ utm_source: 'old', hsa_grp: 'g1' });
  captureParamsFromUrl();
  results.roundTrip = { stored: loadParams(), merged: trackingParams() };
  return results;
`;

function probeParams(js, customParams, search) {
  const href = `https://client.com/p${search}`;
  const dom = makeDom(href);
  dom.sandbox.NAMES = NAMES;
  dom.sandbox.QUERIES = QUERIES;
  dom.sandbox._SL = { customParams };
  return run(dom, `${js}\n${PROBE}`);
}

// The two blocks EXACTLY as they stood before the refactor, lifted from git and
// pasted here verbatim. Do not tidy, reformat or "fix" them — their only job is
// to be the old behaviour, so the probe below can show the generated versions
// answer identically. If a deliberate rule change makes these fail, update the
// generator first, confirm the failure is the change you meant, then update
// these to match.
const goldenSnippet = `
  // ─── Tracking params (mirrors tracker.js — keep the two in sync) ────────────
  //
  // Capture used to read window.location.search at submit time only, so an ad
  // landing on page 1 with the form on page 2 saved a lead with blank UTMs.
  // Params are now stored on every page load and read back at submit.
  //
  // Deliberately a SEPARATE key from sl_ctx, which holds variant assignment.
  var PARAMS_KEY = 'sl_params';
  var PARAMS_TTL = 90 * 24 * 60 * 60 * 1000;

  // Params with a dedicated form_leads column — everything else goes to
  // extra_params. Never both; dual-write would let the two disagree.
  var LEGACY_PARAM_KEYS = ['utm_source','utm_medium','utm_content','utm_term','utm_campaign','gclid','fbclid'];

  // NOTE: fbc_id is NOT fbclid. Facebook sends both; different params.
  var CLICK_ID_PARAMS = {
    gclid:1, fbclid:1, fbc_id:1, fbp:1, msclkid:1, ttclid:1, li_fat_id:1,
    twclid:1, dclid:1, wbraid:1, gbraid:1, epik:1, sccid:1, irclickid:1
  };

  // Explicit list, NOT a bare /_id$/ regex — that would sweep up user_id,
  // session_id and order_id, putting PII into an analytics table.
  var EXTRA_ID_PARAMS = {
    h_ad_id:1, ad_id:1, adset_id:1, campaign_id:1, creative_id:1, placement_id:1
  };

  var MAX_PARAMS = 40, MAX_PARAM_KEY = 100, MAX_PARAM_VALUE = 500, MAX_PARAMS_SERIALIZED = 8192;

  var CUSTOM_PARAMS = {};
  (_SL.customParams || []).forEach(function(n) { CUSTOM_PARAMS[n] = 1; });

  function isTrackingParam(name) {
    if (!name) return false;
    var n = String(name).toLowerCase();
    // Ours — also what keeps decorateFormForSubmit's sl_* hidden inputs out.
    if (n.indexOf('sl_') === 0) return false;
    if (n.indexOf('utm_') === 0) return true;
    if (n.indexOf('hsa_') === 0) return true;
    if (CLICK_ID_PARAMS[n] === 1) return true;
    if (EXTRA_ID_PARAMS[n] === 1) return true;
    if (CUSTOM_PARAMS[n] === 1) return true;
    return false;
  }

  function collectTrackingParams(sp) {
    var out = {}, count = 0;
    try {
      sp.forEach(function(value, key) {
        if (count >= MAX_PARAMS) return;
        if (!isTrackingParam(key)) return;
        if (!value || key.length > MAX_PARAM_KEY) return;
        out[key] = value.length > MAX_PARAM_VALUE ? value.slice(0, MAX_PARAM_VALUE) : value;
        count++;
      });
    } catch(e) {}
    return out;
  }

  function saveParams(p) {
    try {
      var body = JSON.stringify({ p: p, ts: Date.now() });
      if (body.length > MAX_PARAMS_SERIALIZED) return;
      localStorage.setItem(PARAMS_KEY, body);
    } catch(e) {}
  }

  function loadParams() {
    try {
      var raw = JSON.parse(localStorage.getItem(PARAMS_KEY) || 'null');
      if (!raw || !raw.p || !raw.ts) return {};
      if (Date.now() - raw.ts > PARAMS_TTL) return {};
      return raw.p;
    } catch(e) { return {}; }
  }

  function captureParamsFromUrl() {
    try {
      var found = collectTrackingParams(new URLSearchParams(window.location.search));
      // Never write an empty set — otherwise page 2 wipes page 1's params,
      // which is the exact bug being fixed.
      if (!Object.keys(found).length) return;
      // Last touch: a new inbound URL replaces the WHOLE set, so Monday's
      // hsa_ad can never mix with Thursday's utm_campaign.
      saveParams(found);
    } catch(e) {}
  }

  // Stored params, overlaid with the live URL (same-page beats remembered).
  function trackingParams() {
    var out = {}, k;
    var stored = loadParams();
    for (k in stored) { if (stored.hasOwnProperty(k)) out[k] = stored[k]; }
    var live = collectTrackingParams(new URLSearchParams(window.location.search));
    for (k in live) { if (live.hasOwnProperty(k)) out[k] = live[k]; }
    return out;
  }

  function splitTrackingParams(all) {
    var utm = {}, extra = {}, k;
    for (k in all) {
      if (!all.hasOwnProperty(k)) continue;
      if (LEGACY_PARAM_KEYS.indexOf(k) >= 0) utm[k] = all[k];
      else extra[k] = all[k];
    }
    return { utm: utm, extra: extra };
  }
`;

const goldenTracker = `
  // ─── Tracking params (mirrors the inline snippet in src/lib/tracking.ts) ────
  //
  // Capture used to read window.location.search at submit time only, so an ad
  // landing on page 1 with the form on page 2 saved a lead with blank UTMs —
  // "the traffic didn't convert" when it actually had. Params are now stored on
  // every page load and read back at submit.
  //
  // Deliberately a SEPARATE key from sl_tracking: that holds variant assignment
  // and feeds the Method 1-4 detection chain. Polluting it risks the boot path.
  var PARAMS_KEY = "sl_params";
  var PARAMS_TTL = 90 * 24 * 60 * 60 * 1000; // matches sl_visitor / sl_tracking

  // Params with a dedicated form_leads column. These keep their exact existing
  // behaviour; everything else goes to extra_params. Never both — dual-write
  // would let the two disagree.
  var LEGACY_PARAM_KEYS = ["utm_source","utm_medium","utm_content","utm_term","utm_campaign","gclid","fbclid"];

  // NOTE: fbc_id is NOT fbclid. Facebook ads send both; they are different
  // params and reading one as the other silently drops attribution.
  var CLICK_ID_PARAMS = {
    gclid:1, fbclid:1, fbc_id:1, fbp:1, msclkid:1, ttclid:1, li_fat_id:1,
    twclid:1, dclid:1, wbraid:1, gbraid:1, epik:1, sccid:1, irclickid:1
  };

  // Explicit list, NOT a bare /_id$/ regex — a suffix match would sweep up
  // user_id, session_id and order_id, putting session identifiers and PII into
  // an analytics table we export to CSV and push to HubSpot.
  var EXTRA_ID_PARAMS = {
    h_ad_id:1, ad_id:1, adset_id:1, campaign_id:1, creative_id:1, placement_id:1
  };

  var MAX_PARAMS = 40, MAX_PARAM_KEY = 100, MAX_PARAM_VALUE = 500, MAX_PARAMS_SERIALIZED = 8192;

  function isTrackingParam(name) {
    if (!name) return false;
    var n = String(name).toLowerCase();
    // Ours. Echoing these back would confuse the detection chain, and it is what
    // stops decorateFormForSubmit's hidden sl_* inputs being captured as leads.
    if (n.indexOf("sl_") === 0) return false;
    if (n.indexOf("utm_") === 0) return true;
    if (n.indexOf("hsa_") === 0) return true; // machine-readable ad/adset/campaign IDs
    if (CLICK_ID_PARAMS[n] === 1) return true;
    if (EXTRA_ID_PARAMS[n] === 1) return true;
    return false;
  }

  function collectTrackingParams(sp) {
    var out = {}, count = 0;
    try {
      sp.forEach(function(value, key) {
        if (count >= MAX_PARAMS) return;
        if (!isTrackingParam(key)) return;
        if (!value || key.length > MAX_PARAM_KEY) return;
        out[key] = value.length > MAX_PARAM_VALUE ? value.slice(0, MAX_PARAM_VALUE) : value;
        count++;
      });
    } catch(e) {}
    return out;
  }

  function saveParams(p) {
    try {
      var body = JSON.stringify({ p: p, ts: Date.now() });
      if (body.length > MAX_PARAMS_SERIALIZED) return;
      localStorage.setItem(PARAMS_KEY, body);
    } catch(e) {}
  }

  function loadParams() {
    try {
      var raw = JSON.parse(localStorage.getItem(PARAMS_KEY) || "null");
      if (!raw || !raw.p || !raw.ts) return {};
      if (Date.now() - raw.ts > PARAMS_TTL) return {};
      return raw.p;
    } catch(e) { return {}; }
  }

  // Runs on every page load, before boot and independent of _ctx.
  function captureParamsFromUrl() {
    try {
      var found = collectTrackingParams(new URLSearchParams(window.location.search));
      var keys = Object.keys(found);
      // Never write an empty set — otherwise page 2 wipes page 1's params,
      // which is the exact bug being fixed.
      if (!keys.length) return;
      // Last touch: a new inbound URL replaces the WHOLE set. Merging
      // param-by-param across visits would mix Monday's hsa_ad with Thursday's
      // utm_campaign and describe an ad that never existed.
      saveParams(found);
    } catch(e) {}
  }

  // Stored params, overlaid with anything on the live URL (same-page is more
  // specific than remembered).
  function trackingParams() {
    var out = {}, k;
    var stored = loadParams();
    for (k in stored) { if (stored.hasOwnProperty(k)) out[k] = stored[k]; }
    var live = collectTrackingParams(new URLSearchParams(window.location.search));
    for (k in live) { if (live.hasOwnProperty(k)) out[k] = live[k]; }
    return out;
  }

  // Splits into the 7 dedicated columns vs everything else (extra_params).
  function splitTrackingParams(all) {
    var utm = {}, extra = {}, k;
    for (k in all) {
      if (!all.hasOwnProperty(k)) continue;
      if (LEGACY_PARAM_KEYS.indexOf(k) >= 0) utm[k] = all[k];
      else extra[k] = all[k];
    }
    return { utm: utm, extra: extra };
  }
`;
const genSnippet = buildTrackingParamsJs({ customParamsExpr: '_SL.customParams' });
const genTracker = buildTrackingParamsJs({ customParamsExpr: null });

for (const search of ['', '?utm_source=meta&gclid=abc', '?affiliate_id=partner7', '?user_id=5']) {
  for (const custom of [[], ['affiliate_id'], ['affiliate_id', 'ref']]) {
    const label = `search=${search || '(none)'} custom=[${custom}]`;
    assert(
      `snippet param block is unchanged by the refactor — ${label}`,
      eq(probeParams(goldenSnippet, custom, search), probeParams(genSnippet, custom, search)),
    );
  }
  assert(
    `tracker.js param block is unchanged by the refactor — search=${search || '(none)'}`,
    eq(probeParams(goldenTracker, [], search), probeParams(genTracker, [], search)),
  );
}

// The empty CUSTOM_PARAMS the tracker build now carries must be inert: with no
// custom names, both builds have to agree.
assert(
  'an empty CUSTOM_PARAMS changes no answer (tracker build === snippet build with no custom names)',
  eq(
    probeParams(genTracker, [], '?utm_source=meta&affiliate_id=x'),
    probeParams(genSnippet, [], '?utm_source=meta&affiliate_id=x'),
  ),
);

// ═════════════════════════════════════════════════════════════════════════════
// 2. PARAM LOGIC — the rules the block is supposed to enforce
// ═════════════════════════════════════════════════════════════════════════════

{
  const dom = makeDom('https://client.com/p?utm_source=meta&gclid=abc&user_id=7&sl_vid=v1');
  dom.sandbox._SL = { customParams: ['affiliate_id'] };
  const r = run(dom, `${genSnippet}
    captureParamsFromUrl();
    return {
      accepted: ['utm_source','hsa_grp','gclid','ad_id','affiliate_id'].map(isTrackingParam),
      rejected: ['sl_vid','user_id','session_id','order_id','ref'].map(isTrackingParam),
      stored: loadParams()
    };`);
  assert('accepts utm_, hsa_, click IDs, ad IDs and registered custom names', r.accepted.every(Boolean));
  assert('rejects sl_*, user_id, session_id, order_id and unknown names', r.rejected.every((x) => x === false));
  assert('captures only tracking params from the URL', eq(r.stored, { utm_source: 'meta', gclid: 'abc' }));
}

{
  // Page 2 has no params of its own; the ones from the ad must still be there.
  const dom = makeDom('https://client.com/page2');
  dom.sandbox._SL = { customParams: [] };
  const r = run(dom, `${genSnippet}
    saveParams({ utm_source: 'meta', utm_campaign: 'spring' });
    captureParamsFromUrl();
    return trackingParams();`);
  assert('a second page with no params still reads back the ad params', eq(r, { utm_source: 'meta', utm_campaign: 'spring' }));
}

{
  // A NEW inbound URL replaces the whole set — Monday's ad must not blend into
  // Thursday's.
  const dom = makeDom('https://client.com/p?utm_source=google');
  dom.sandbox._SL = { customParams: [] };
  const r = run(dom, `${genSnippet}
    saveParams({ utm_source: 'meta', hsa_grp: 'monday' });
    captureParamsFromUrl();
    return { stored: loadParams(), merged: trackingParams() };`);
  assert('a new inbound URL replaces the whole stored set, never merges', eq(r.stored, { utm_source: 'google' }));
  assert('nothing from the previous campaign survives', !('hsa_grp' in r.merged));
}

{
  const dom = makeDom(`https://client.com/p?utm_term=${'z'.repeat(700)}`);
  dom.sandbox._SL = { customParams: [] };
  const r = run(dom, `${genSnippet} return collectTrackingParams(new URLSearchParams(window.location.search));`);
  assert('an over-long value is truncated to 500 chars', r.utm_term.length === 500);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. IFRAME HOOK
// ═════════════════════════════════════════════════════════════════════════════

// Builds a sandbox with the params block + a controllable muted/forward pair +
// the hook, mirroring how tracker.js embeds it.
function makeHooked({ href = 'https://client.com/p?utm_source=meta&gclid=abc', muted = false, forward = true, stored = null } = {}) {
  const dom = makeDom(href);
  dom.sandbox._SL = { customParams: [] };
  const hook = buildIframeHookBody({ mutedExpr: 'MUTED', forwardExpr: 'FORWARD' });
  run(dom, `
    ${genSnippet}
    var MUTED = ${JSON.stringify(muted)};
    var FORWARD = ${JSON.stringify(forward)};
    ${stored ? `saveParams(${JSON.stringify(stored)});` : ''}
    captureParamsFromUrl();
    ${hook}
    window.__mkIframe = function() { return document.createElement('iframe'); };
  `);
  return dom;
}

function q(u) {
  return u ? Object.fromEntries(new URL(u).searchParams.entries()) : {};
}

// -- Hook 1: iframe.src = '...' (how every widget SDK builds its frame) -------
{
  const dom = makeHooked();
  const f = dom.win.__mkIframe();
  f.src = 'https://calendly.com/acme/intro';
  const p = q(f.src);
  assert('src setter: a Calendly embed gains the visitor ad params', p.utm_source === 'meta' && p.gclid === 'abc');
  assert('src setter: no sl_* context leaks into a third-party embed',
    !('sl_vid' in p) && !('sl_tid' in p) && !('sl_vh' in p));
}

// -- Hook 2: setAttribute('src', ...) ----------------------------------------
{
  const dom = makeHooked();
  const f = dom.win.__mkIframe();
  f.setAttribute('src', 'https://meetings.hubspot.com/rep/demo');
  const p = q(f.getAttribute('src'));
  assert('setAttribute: a HubSpot meetings embed gains the ad params', p.utm_source === 'meta' && p.gclid === 'abc');
}

// -- Explicit beats inherited, per param -------------------------------------
{
  const dom = makeHooked();
  const f = dom.win.__mkIframe();
  f.src = 'https://calendly.com/acme?utm_source=partner';
  const p = q(f.src);
  assert("a param the vendor URL already sets keeps its own value", p.utm_source === 'partner');
  assert('the params it does not set are still appended', p.gclid === 'abc');
}

// -- Skip cases ---------------------------------------------------------------
{
  const dom = makeHooked();
  const f = dom.win.__mkIframe();
  f.src = 'https://client.com/inner';
  assert('same-origin iframes are left alone', f.src === 'https://client.com/inner');
}
{
  const dom = makeHooked();
  for (const u of ['about:blank', 'javascript:void(0)', 'data:text/html,<p>x']) {
    const f = dom.win.__mkIframe();
    f.src = u;
    assert(`non-http src is left alone (${u.slice(0, 18)})`, f.src === u);
  }
}
{
  const dom = makeHooked();
  const f = dom.win.__mkIframe();
  f.setAttribute('data-sl-no-params', '');
  f.src = 'https://js.stripe.com/v3/elements-inner';
  assert('data-sl-no-params on the iframe opts it out', f.src === 'https://js.stripe.com/v3/elements-inner');
}
{
  const dom = makeHooked();
  const wrap = dom.document.createElement('div');
  wrap.setAttribute('data-sl-no-params', '');
  const f = dom.win.__mkIframe();
  wrap.appendChild(f);
  f.src = 'https://js.stripe.com/v3/elements-inner';
  assert('data-sl-no-params on an ancestor opts the iframe out', f.src === 'https://js.stripe.com/v3/elements-inner');
}
{
  const dom = makeHooked({ forward: false });
  const f = dom.win.__mkIframe();
  f.src = 'https://calendly.com/acme';
  assert('forward_url_params off leaves every iframe untouched', f.src === 'https://calendly.com/acme');
}
{
  const dom = makeHooked({ muted: true });
  const f = dom.win.__mkIframe();
  f.src = 'https://calendly.com/acme';
  assert('a muted page (scan / preview / over-cap) is never rewritten', f.src === 'https://calendly.com/acme');
}
{
  const dom = makeHooked({ href: 'https://client.com/p' });
  const f = dom.win.__mkIframe();
  f.src = 'https://calendly.com/acme';
  assert('direct traffic with no ad params is a complete no-op', f.src === 'https://calendly.com/acme');
}

// -- Hook 3: <iframe src> written into the HTML (the observer fallback) -------
{
  const dom = makeHooked();
  const f = dom.win.__mkIframe();
  f.setAttribute('src', 'https://calendly.com/acme');
  // setAttribute already decorated it; prove the observer path independently by
  // writing the attribute store directly, the way the HTML parser would.
  f._attrs.src = 'https://calendly.com/acme';
  dom.document.documentElement.appendChild(f);
  const p = q(f.getAttribute('src'));
  assert('observer: a static <iframe src> in the page HTML is decorated on insertion',
    p.utm_source === 'meta' && p.gclid === 'abc');
}
{
  // A long-lived embed must never be repointed a second time — that would
  // reload a booking the visitor is halfway through.
  const dom = makeHooked();
  const f = dom.win.__mkIframe();
  f._attrs.src = 'https://calendly.com/acme';
  dom.document.documentElement.appendChild(f);
  const afterFirst = f.getAttribute('src');
  f._attrs.src = 'https://calendly.com/acme';        // pretend the page reset it
  dom.document.documentElement.appendChild(f);       // re-notify the observer
  assert('observer: never touches the same iframe twice', f.getAttribute('src') === 'https://calendly.com/acme');
  assert('observer: the first pass did decorate it', afterFirst !== 'https://calendly.com/acme');
}
{
  const dom = makeHooked();
  const wrap = dom.document.createElement('div');
  const f = dom.win.__mkIframe();
  f._attrs.src = 'https://calendly.com/acme';
  wrap.childNodes.push(f);
  f.parentNode = wrap;
  dom.document.documentElement.appendChild(wrap);
  assert('observer: finds an iframe nested inside an added subtree',
    q(f.getAttribute('src')).utm_source === 'meta');
}

// -- URL length ceiling -------------------------------------------------------
{
  const dom = makeHooked({ href: `https://client.com/p?utm_source=meta&utm_term=${'z'.repeat(400)}` });
  const f = dom.win.__mkIframe();
  const base = `https://calendly.com/acme?pad=${'x'.repeat(1700)}`;
  f.src = base;
  assert('a URL at the 2000-char ceiling stops appending rather than overflowing', f.src.length <= 2100);
}

// -- Double install -----------------------------------------------------------
{
  const dom = makeHooked();
  const hook = buildIframeHookBody({ mutedExpr: 'MUTED', forwardExpr: 'FORWARD' });
  run(dom, hook); // second install, as if tracker.js were also tagged on the page
  const f = dom.win.__mkIframe();
  f.src = 'https://calendly.com/acme';
  const p = q(f.src);
  assert('a second hook install stands down (no double-wrapped setter)',
    p.utm_source === 'meta' && Object.keys(p).length === 2);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. HEAD SCRIPT — the standalone build served in <head>
// ═════════════════════════════════════════════════════════════════════════════

{
  const head = buildIframeHeadScript(['affiliate_id'], true, '');
  assert('head script is a self-contained <script> tag', head.startsWith('<script>') && head.trim().endsWith('</script>'));
  assert('head script carries its own param logic (it runs before the body snippet)', head.includes('function trackingParams()'));
  assert('head script captures params itself', head.includes('captureParamsFromUrl();'));
  assert('head script passes registered custom param names through', head.includes('"affiliate_id"'));

  const dom = makeDom('https://client.com/p?utm_source=meta&affiliate_id=partner7');
  run(dom, head.replace(/^<script>/, '').replace(/<\/script>\s*$/, ''));
  const f = dom.document.createElement('iframe');
  f.src = 'https://calendly.com/acme';
  const p = q(f.src);
  assert('head script decorates a widget iframe end to end', p.utm_source === 'meta');
  assert('head script honours registered custom param names', p.affiliate_id === 'partner7');
}
{
  // Preview and scan render the page for staff; nothing may be rewritten.
  const head = buildIframeHeadScript([], true, 'preview');
  const dom = makeDom('https://client.com/p?utm_source=meta');
  run(dom, head.replace(/^<script>/, '').replace(/<\/script>\s*$/, ''));
  const f = dom.document.createElement('iframe');
  f.src = 'https://calendly.com/acme';
  assert('head script in preview mode rewrites nothing', f.src === 'https://calendly.com/acme');
}
{
  const head = buildIframeHeadScript([], true, '');
  const dom = makeDom('https://client.com/p?utm_source=meta&sl_scan=1');
  run(dom, head.replace(/^<script>/, '').replace(/<\/script>\s*$/, ''));
  const f = dom.document.createElement('iframe');
  f.src = 'https://calendly.com/acme';
  assert('head script during a goal scan rewrites nothing', f.src === 'https://calendly.com/acme');
}
{
  const head = buildIframeHeadScript([], false, '');
  const dom = makeDom('https://client.com/p?utm_source=meta');
  run(dom, head.replace(/^<script>/, '').replace(/<\/script>\s*$/, ''));
  const f = dom.document.createElement('iframe');
  f.src = 'https://calendly.com/acme';
  assert('head script with forward_url_params off rewrites nothing', f.src === 'https://calendly.com/acme');
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. REGRESSION — the paths that already worked must still be wired
// ═════════════════════════════════════════════════════════════════════════════

const snippetSrc = readFileSync(join(repoRoot, 'src', 'lib', 'tracking.ts'), 'utf8');
const trackerSrc = readFileSync(join(repoRoot, 'src', 'app', 'tracker.js', 'route.ts'), 'utf8');
const serveSrc = readFileSync(join(repoRoot, 'src', 'app', 'api', 'serve', 'route.ts'), 'utf8');

for (const [file, src] of [['tracking.ts', snippetSrc], ['tracker.js', trackerSrc]]) {
  assert(`${file}: link decoration still wired on mousedown/auxclick`,
    src.includes("addEventListener('mousedown', decorateFromEvent, true)") ||
    src.includes('addEventListener("mousedown", decorateFromEvent, true)'));
  assert(`${file}: window.open still patched`, src.includes('patchWindowOpen()'));
  assert(`${file}: Navigation API watcher still wired`, src.includes('watchNavigations()'));
  assert(`${file}: form action decoration still present`, src.includes('decorateFormForSubmit'));
  assert(`${file}: UTM hidden-field injection still present`, src.includes('injectUtmFieldsIntoForm'));
  assert(`${file}: params block now comes from the shared source`, src.includes('buildTrackingParamsJs('));
  assert(`${file}: no leftover hand-copied param block`,
    !src.includes('var CLICK_ID_PARAMS = {'), 'the inline copy should be gone');
}

assert('tracker.js: params are still captured before detect()',
  trackerSrc.indexOf('captureParamsFromUrl();') < trackerSrc.indexOf('detect(boot);'));
assert('tracker.js: the iframe hook installs after detect() has set scan/preview mode',
  trackerSrc.indexOf('detect(boot);') < trackerSrc.indexOf('buildIframeHookBody('));
assert('tracker.js: the hook reads the live mute state, not a snapshot',
  trackerSrc.includes("mutedExpr: 'muted()'"));

assert('serve route: the iframe head script is first in <head>',
  /const headScripts: string\[\] = \[\s*\n\s*buildIframeHeadScript\(/.test(serveSrc));
assert('serve route: the test\'s own head scripts are still injected',
  serveSrc.includes('if (testHeadScriptsHtml) headScripts.push(testHeadScriptsHtml);'));
assert('serve route: the head script is gated on the per-test switch',
  serveSrc.includes('buildIframeHeadScript(customParamNames, test.forward_url_params !== false'));
assert('serve route: the body tracking snippet is still injected',
  serveSrc.includes('injectIntoHtml(htmlWithUtm, headScripts, bodyEndScripts, trackingSnippet)'));

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE REAL EMITTED SCRIPTS — the interpolation has to produce valid JS
// ═════════════════════════════════════════════════════════════════════════════
//
// Both files build their browser script by interpolating the shared block into
// a template literal. A misplaced brace there is invisible to tsc (it is just a
// string) and would take down tracking on every served page, so parse what they
// actually emit.

const emitDir = join(outDir, 'emit');
mkdirSync(emitDir, { recursive: true });

writeFileSync(
  join(emitDir, 'tracking.ts'),
  snippetSrc
    .replace("import type { ConversionGoal } from '@/types';", 'type ConversionGoal = { id: string; type: string; selector?: string | null; url_pattern?: string | null };')
    .replace("from './tracking-params'", "from '../src/tracking-params'"),
);
writeFileSync(
  join(emitDir, 'tracker.ts'),
  trackerSrc
    .replace("import { NextRequest, NextResponse } from 'next/server';", 'type NextRequest = { headers: { get(k: string): string | null } }; const NextResponse: any = class {};')
    .replace(/@\/lib\/tracking-params/g, '../src/tracking-params')
    .replace(/@\/lib\/tracking-iframes/g, '../src/tracking-iframes')
    .replace('function buildTrackerScript(', 'export function buildTrackerScript('),
);

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    join(emitDir, 'tracking.ts'),
    join(emitDir, 'tracker.ts'),
    '--outDir', join(outDir, 'emitjs'),
    '--target', 'es2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--skipLibCheck',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const { buildTrackingSnippet } = require(join(outDir, 'emitjs', 'emit', 'tracking.js'));
const { buildTrackerScript } = require(join(outDir, 'emitjs', 'emit', 'tracker.js'));

const snippetOut = buildTrackingSnippet('t1', 'v1', 'vh1', [], 'https://www.trysplitlab.com', ['affiliate_id'], '', true);
const trackerOut = buildTrackerScript('https://www.trysplitlab.com');
const headOut = buildIframeHeadScript(['affiliate_id'], true, '');

for (const [name, raw] of [
  ['inline tracking snippet', snippetOut.replace(/^<script>/, '').replace(/<\/script>\s*$/, '')],
  ['tracker.js', trackerOut],
  ['iframe head script', headOut.replace(/^<script>/, '').replace(/<\/script>\s*$/, '')],
]) {
  let ok = true, err = '';
  try { new vm.Script(raw, { filename: name }); } catch (e) { ok = false; err = e.message; }
  assert(`${name} parses as valid JavaScript`, ok, err);
}

assert('inline snippet still carries the shared param block', snippetOut.includes('var CLICK_ID_PARAMS = {'));
assert('inline snippet still reads its registered custom params', snippetOut.includes('_SL.customParams'));
assert('tracker.js still carries the shared param block', trackerOut.includes('var CLICK_ID_PARAMS = {'));
assert('tracker.js now carries the iframe hook', trackerOut.includes('window.__SL_IFRAME_HOOK__'));
assert('the inline snippet does NOT duplicate the iframe hook (the head script owns it)',
  !snippetOut.includes('__SL_IFRAME_HOOK__'));

const offSnippet = buildTrackingSnippet('t1', 'v1', 'vh1', [], 'https://www.trysplitlab.com', [], '', false);
assert('forward_url_params off still reaches the inline snippet', offSnippet.includes('var _forwardParams = false;'));

rmSync(outDir, { recursive: true, force: true });

console.log(failed === 0 ? '\nAll tracking-iframe checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
