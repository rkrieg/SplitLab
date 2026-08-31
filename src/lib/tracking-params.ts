/**
 * The single source for "which URL params are ad-tracking params, and how do we
 * remember them across a visit".
 *
 * WHY THIS FILE EXISTS
 * This block used to be hand-copied into two places — the inline snippet
 * (src/lib/tracking.ts) and the external tracker (src/app/tracker.js/route.ts) —
 * each carrying a "keep the two in sync" comment and relying on whoever touched
 * one remembering to touch the other. Adding a third consumer (the iframe hook
 * in src/lib/tracking-iframes.ts) would have made that three copies of the
 * click-ID list, three copies of the PII guard on EXTRA_ID_PARAMS, and three
 * chances for them to disagree about what counts as a tracking param. They are
 * all generated from here instead.
 *
 * This emits JavaScript SOURCE, not TypeScript that runs — the output is
 * interpolated into a browser script. Keep it ES5: it lands inside "use strict"
 * IIFEs served to whatever browser the visitor brought.
 *
 * The emitted block is pure: constants plus functions, no side effects. Callers
 * decide when to invoke captureParamsFromUrl() — the snippet does it at body
 * end, the head hook does it in <head>, and both writing the same value is
 * harmless (last-touch semantics, see below).
 *
 * Declares: PARAMS_KEY, PARAMS_TTL, LEGACY_PARAM_KEYS, CLICK_ID_PARAMS,
 * EXTRA_ID_PARAMS, MAX_PARAMS, MAX_PARAM_KEY, MAX_PARAM_VALUE,
 * MAX_PARAMS_SERIALIZED, CUSTOM_PARAMS, isTrackingParam, collectTrackingParams,
 * saveParams, loadParams, captureParamsFromUrl, trackingParams,
 * splitTrackingParams.
 */

export interface TrackingParamsJsOptions {
  /**
   * A JS expression evaluating to an array of extra param names to treat as
   * tracking params — staff-registered workspace/test-scoped names (an affiliate
   * ID, say) that the built-in utm_, hsa_ and click-ID detection cannot know
   * about.
   *
   * Pass `null` when the consumer has no way to know them. tracker.js is the
   * case: it is a static cacheable script with no test context at parse time, so
   * it has always run without custom params and continues to.
   */
  customParamsExpr?: string | null;
  /** Indentation prefix for every emitted line. Cosmetic only. */
  indent?: string;
}

export function buildTrackingParamsJs(opts: TrackingParamsJsOptions = {}): string {
  const { customParamsExpr = null, indent = '  ' } = opts;

  const customParamsBlock = customParamsExpr
    ? `
// Staff-registered param names (workspace- or test-scoped) not covered by the
// built-in utm_*/hsa_*/click-ID detection — e.g. a custom affiliate ID.
// Extends isTrackingParam() so these are captured, forwarded and
// hidden-field-injected exactly like an auto-detected param.
//
// KNOWN, DELIBERATELY UNCHANGED: names are stored as registered, but
// isTrackingParam() lowercases before the lookup, so a name registered with a
// capital ("AffiliateID") never matches. Lowercasing here would fix it and
// would also start capturing params that are silently ignored today — a
// behaviour change, not a refactor. Left exactly as it was; fix it on purpose.
var CUSTOM_PARAMS = {};
(${customParamsExpr} || []).forEach(function(n) { CUSTOM_PARAMS[n] = 1; });
`
    : `
// No custom params here: this consumer has no test context to read them from.
var CUSTOM_PARAMS = {};
`;

  const body = `
// ─── Tracking params (generated from src/lib/tracking-params.ts) ────────────
//
// Capture used to read window.location.search at submit time only, so an ad
// landing on page 1 with the form on page 2 saved a lead with blank UTMs —
// "the traffic didn't convert" when it actually had. Params are stored on
// every page load and read back at submit.
//
// Deliberately a SEPARATE key from the variant-assignment context (sl_ctx /
// sl_tracking): that feeds the boot-time detection chain, and polluting it
// risks the boot path.
var PARAMS_KEY = 'sl_params';
var PARAMS_TTL = 90 * 24 * 60 * 60 * 1000; // matches the sl_visitor cookie

// Params with a dedicated form_leads column. Everything else goes to
// extra_params. Never both — dual-write would let the two disagree.
var LEGACY_PARAM_KEYS = ['utm_source','utm_medium','utm_content','utm_term','utm_campaign','gclid','fbclid'];

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
${customParamsBlock}
function isTrackingParam(name) {
  if (!name) return false;
  var n = String(name).toLowerCase();
  // Ours. Echoing these back would confuse the detection chain, and it is what
  // stops decorateFormForSubmit's hidden sl_* inputs being captured as leads.
  if (n.indexOf('sl_') === 0) return false;
  if (n.indexOf('utm_') === 0) return true;
  if (n.indexOf('hsa_') === 0) return true; // machine-readable ad/adset/campaign IDs
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

// Runs on every page load, independent of variant context. Safe to call more
// than once per page: the second call reads the same URL and writes the same
// value, which is why the head hook and the body snippet can both call it.
function captureParamsFromUrl() {
  try {
    var found = collectTrackingParams(new URLSearchParams(window.location.search));
    // Never write an empty set — otherwise page 2 wipes page 1's params,
    // which is the exact bug this exists to fix.
    if (!Object.keys(found).length) return;
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
}`;

  return body
    .split('\n')
    .map((line) => (line.length ? indent + line : line))
    .join('\n')
    .trim();
}
