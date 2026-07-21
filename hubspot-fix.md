# HubSpot "Conversion Page: Unavailable" Fix — Status

Branch: `fix-hubspot-form` (off `main`)

## The problem

Comparing two HubSpot form submissions:
- **Unbounce (native HubSpot integration)**: "Conversion Page" column shows the real page URL.
- **SplitLab → HubSpot integration** (client: United Exploration): "Conversion Page" shows **"Unavailable"**.

A cookie-related console error was also observed alongside this, not confirmed to be related (see Open Items).

## Root cause

`syncLeadToHubSpot()` (`src/lib/integrations/hubspot.ts`) was only ever sending `context.ipAddress` to HubSpot's forms-submission API. HubSpot needs `context.pageUri` (and optionally `pageName`) to populate the Conversion Page column — without it, every SplitLab-originated submission reads "Unavailable" regardless of anything else being correct.

Separately, HubSpot appears to **spam-flag / suppress page attribution for leads whose asserted domain isn't verified/registered in the HubSpot portal** — confirmed by testing: sending a valid `hutk` (HubSpot visitor token) alone did not populate Conversion Page, but combining `pageUri` + `pageName` + `hutk` **does populate it when the domain is verified in HubSpot**.

## What's implemented (current HEAD)

### 1. Capture the real page URL/title at submit time
Commit `dab91c8`. Changes:
- `src/app/tracker.js/route.ts`, `src/lib/tracking.ts` (HTML variant tracker): capture `window.location.href` / `document.title` at form-submit time (before any thank-you-page navigation), send as `pageUrl`/`pageTitle` in the form-lead payload.
- `src/app/api/form-leads/route.ts`: accepts `pageUrl`/`pageTitle`, sanitizes (`clean()` — trims, caps length: 2048 for URL, 255 for title — public endpoint, don't trust input), stores in new `form_leads.page_url` / `form_leads.page_title` columns, forwards to the HubSpot dispatch payload.
- `supabase/migrations/035_form_leads_page_url.sql`: adds the two nullable columns.
- `src/lib/integrations/hubspot.ts`: sends `context.pageUri` / `context.pageName` (using `?? undefined` so absent values are dropped from the JSON rather than sent as `null`, which HubSpot would reject/mishandle).

### 2. Proxy mode: iframe can't see its own wrapper URL
Commit `88b04d5`. In proxy mode, `serve/route.ts` wraps the destination in an iframe on the custom domain; `tracker.js` runs *inside* the iframe, pointed at `redirect_url` — so `window.location.href` there is the underlying redirect URL, not the wrapper URL the visitor actually sees, and it's cross-origin so the iframe can't read the parent's URL directly.
- Fix: `serve/route.ts` computes the wrapper URL and passes it into the iframe via a new `sl_purl` query param.
- `tracker.js` reads `sl_purl` into a page-load-only variable `_purl` (deliberately **not** persisted to `localStorage`/`_ctx` — that's reloaded for returning visitors and would attach a stale wrapper URL to a lead submitted on an unrelated page later). `_purl` wins over `window.location.href` when building the form-lead payload.

### 3. Proxy mode without a custom domain (shareable/preview links)
Commits `270f950`, `b856ff5`. The shareable-link routes (`src/app/[slug]/[testId]/route.ts` and the `[...rest]` catch-all variant) fetch `/api/serve` server-side, so `serve/route.ts` can't see the visitor-facing URL itself in that case.
- Both routes now forward the visitor-facing URL as a new `public_url` param to `/api/serve`.
- `serve/route.ts` uses `public_url` as the `sl_purl` fallback when there's no custom domain (`domain` is empty — preview/shareable-link case).

### 4. HubSpot native visitor token (`hutk`) — domain-verification workaround
Commits `22d63e4`, `1886127`. Theory: HubSpot may suppress page attribution when the lead's domain isn't verified in the portal. Sending HubSpot's own first-party visitor cookie should let HubSpot attribute the lead using its own recorded session instead of trusting a self-asserted `pageUri`.
- `serve/route.ts`: on **HTML variants only**, if the workspace has HubSpot connected (`workspace_integrations` row, `type = 'hubspot'`, `enabled = true`), injects the portal's own tracking script (`https://js.hs-scripts.com/{hub_id}.js`) into `<head>`, so the `hubspotutk` cookie gets set first-party.
- `src/lib/tracking.ts`: reads the `hubspotutk` cookie at submit time (`readHutk()`), sends it as `hutk` in the form-lead payload.
- `src/app/api/form-leads/route.ts`: validates `hutk` strictly (`/^[a-f0-9]{32}$/i` — it's attacker-controllable input on a public endpoint), forwards it, never stores it in the DB.
- `src/lib/integrations/hubspot.ts`: sends `pageUri` + `pageName` + `hutk` together in `context` (an earlier intermediate version, `22d63e4`, sent `hutk` *instead of* `pageUri` when present — that either/or branch was reverted in `1886127` once testing showed hutk-alone didn't populate the column).

**Confirmed by the user (2026-07-21): this combination (`pageUri` + `pageName` + `hutk`) populates Conversion Page correctly *when the domain is verified in HubSpot*.**

## Current `context` payload (HEAD)

```js
context: {
  ipAddress: systemData.ip_address ?? undefined,
  pageUri: systemData.page_url ?? undefined,
  pageName: systemData.page_title ?? undefined,
  hutk: systemData.hutk ?? undefined,
}
```

## Known gaps / not yet solved

1. **`hutk` is HTML-variant-only.** The portal tracking script injection in `serve/route.ts` only happens in the HTML-variant code path (~line 379). **Redirect mode (302) and proxy mode never get `hutk`** — those two rely purely on `pageUri`/`pageName`, so for those, correct Conversion Page attribution still fully depends on the client's domain being verified in HubSpot. If a client's domain is *not* verified, redirect/proxy-mode leads will likely still show "Unavailable" (or get spam-flagged) even with this fix.
2. **Redirect-mode regression reported by the user was never independently re-verified** after the later `hutk`-related commits — those commits were written to test the domain-verification theory on HTML variants, not to specifically re-check redirect mode. Needs a fresh test: submit a redirect-mode lead post-fix and confirm Conversion Page populates (assuming domain is verified).
3. **Domain verification is a manual step on the client's HubSpot side** (not automated by SplitLab) — worth deciding whether SplitLab should surface this as a setup requirement/checklist item during HubSpot integration onboarding, since an unverified domain silently degrades the fix's effectiveness.
4. **Cookie-related console error** the user originally noticed alongside the "Unavailable" issue has not been separately investigated. Likely candidate: proxy mode's iframe uses `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"`, and modern browsers partition third-party/sandboxed iframe cookie storage — this is already called out as a known limitation in a code comment at `serve/route.ts` (~line 199-203: "modern browsers partition third-party iframe storage, so tracker.js inside the iframe may lose its context"). Plausible this is the same root cause as the cookie error rather than a separate bug, but not confirmed.
5. **`tracker.js` is cached** (`Cache-Control: public, max-age=300, s-maxage=300`) — any before/after comparison of live behavior should account for up to 5 minutes (or longer, depending on any CDN in front) of stale script still running old logic.

## Suggested next steps

- Re-test redirect mode specifically, with a domain verified in HubSpot, to confirm gap #2 above.
- Decide/communicate the domain-verification requirement (gap #3) to whoever onboards clients' HubSpot integrations.
- If redirect/proxy-mode clients commonly have unverified domains, consider whether the portal tracking script injection (currently HTML-variant-only) should be extended to those modes too, to get `hutk` coverage there.
- Investigate the cookie error independently (gap #4) — get exact error text/screenshot if not already captured.
