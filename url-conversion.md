# URL Conversion (`url_reached`) — Same-Domain Cases

How SplitLab's Conversion URL feature works, and which same-domain scenarios are supported. Verified against the code.

## How it works

A conversion goal of type `url_reached` stores a `url_pattern` (e.g. `/thanks`, `/booking`) in the `conversion_goals` table. A conversion fires when the visitor reaches a URL matching that pattern (case-insensitive regex, tested against both full `href` and `pathname + search`).

Two independent mechanisms check URL goals — **they do not share storage**:

| Mechanism | Where it runs | localStorage key | Cross-test aware? |
|---|---|---|---|
| Injected snippet (`src/lib/tracking.ts`) | SplitLab-served HTML pages (custom domain) | `sl_ctx` (per-test map) | Yes — `checkStoredUrlGoals()` fires other tests' saved goals |
| tracker.js (`src/app/tracker.js/route.ts`) | Client's own site (site-wide install) | `sl_tracking` (per-test map since the `url-conversion-v2` fix; old single-slot values auto-migrate) | Yes — `checkStoredUrlGoals()` fires other stored tests' URL goals; still never reads `sl_ctx` |

Key structural fact: on a custom domain, **every path** is rewritten by middleware to `/api/serve`, which only serves active tests. Any path without an active test returns 404 — there are no "plain pages" on a SplitLab custom domain.

## Working cases ✅

1. **HTML variant, SPA navigation** — pushState/replaceState/popstate/hashchange to `/thanks` within the same page; the snippet wraps history and re-checks its own URL goals.
2. **HTML variant → another SplitLab-served test page on the same custom domain** — test A's snippet saves context to `sl_ctx`; the destination page's snippet runs `checkStoredUrlGoals()` and fires test A's conversion with correct variant/visitor attribution (e.g. `/offer` → `/booking`).
3. **Redirect variant (proxy mode OFF) → client's real domain with tracker.js installed site-wide** — tracker.js resolves `?sl_vid` via `/api/resolve`, stores context in `sl_tracking`; when the visitor reaches `/thanks` on that same origin, tracker.js boots from localStorage and fires the goal. Requires **same origin** (www vs naked domain / subdomains break localStorage sharing).
4. **Dashboard preview URLs** — the catch-all route (`/[slug]/[testId]/[...rest]`) keeps trailing segments in the browser URL so patterns like `/booking` match (note: Open-button previews with `sl_vh` inject no tracking snippet, so no events fire).
5. **Chained redirect variants on the same client domain** — **FIXED on `url-conversion-v2`**: `sl_tracking` is now a per-test map; each stored test's URL goals are checked on every page, attributed to that test's own variant/visitor. Old single-slot values migrate automatically on the visitor's next page load. *(Was not-working; see detailed explanation below.)*

## Not working cases ❌

1. **Redirect variant with proxy mode ON (iframe wrapper)** — the wrapper URL never changes as the visitor navigates inside the iframe, and browsers partition third-party iframe storage. Note: `proxy_mode` **defaults to ON**; working case 3 above only applies when it's explicitly off.
2. **Cross-origin navigation** — HTML variant linking out to the client's real site: the custom domain's localStorage isn't visible there, and `sl_vid` isn't appended to outbound links on this branch. *(A fix exists on an unmerged branch — see detailed explanation below.)*

## Missed conversions — detailed explanations

### Chained redirect variants overwrite each other (FIXED on `url-conversion-v2`)

tracker.js on the client's site remembers "which test is this visitor in" using a **single localStorage slot** (`sl_tracking`). It can only hold **one test's context at a time** — think of it as a whiteboard with room for one instruction.

Example, client site `acme.com` with tracker.js site-wide and two active tests:

- **Test A**: redirect variant → `acme.com/summer-sale`, goal = reach `/thanks`
- **Test B**: redirect variant → `acme.com/pricing`, goal = reach `/signup-done`

1. Visitor hits Test A → 302 to `acme.com/summer-sale?sl_vid=A123`. tracker.js resolves it and stores: *"Test A — watch for /thanks."*
2. Same visitor later enters Test B's flow → lands on `acme.com/pricing?sl_vid=B456`. tracker.js **erases the slot** and stores: *"Test B — watch for /signup-done."* Test A's context is gone.
3. Visitor reaches `acme.com/thanks` — exactly Test A's goal. tracker.js only knows about `/signup-done`, so it does nothing. **Test A's conversion is silently missed.**

Nothing errors — the second test just wipes the first test's memory. With only one test in play per visitor per domain, this never triggers. The inline snippet on SplitLab-hosted pages never had this bug (its `sl_ctx` store is a per-test map); only tracker.js did.

**The fix (implemented on `url-conversion-v2`, 2026-07-15):** `sl_tracking` is now a per-test map `{ [testId]: { vid, vh, ts, goals } }`, mirroring the snippet's `sl_ctx`:

- `store()` writes `m[testId] = ctx` instead of replacing the key; `load()` returns the most-recent entry as the current test (preserves old attribution behavior for forms/leads).
- Old flat single-slot values migrate to the map on the visitor's next page load, before any validation — returning visitors keep their context.
- `checkStoredUrlGoals()` checks all OTHER stored tests' `url_reached` goals on every page load and SPA navigation, sending each conversion with that test's own stored variant/visitor. Skips the current test (its own `checkUrlGoals()` covers it — no double-fire) and skips scan mode.
- Entries expire after 90 days (matches `sl_visitor` cookie); dedup is in-memory per page-load only, so raw goal-hit counts are unchanged.

Verified by simulation against the emitted script: chained A→B→`/thanks` credits Test A correctly, shared-goal-URL credits both tests, single-test flows/migration/TTL/scan/stand-down all behave as before. Expect conversion counts to **rise** after deploy — previously-lost conversions are now recorded.

Code: `saveMap()` / `loadMap()` / `store()` / `load()` / `checkStoredUrlGoals()` in `src/app/tracker.js/route.ts`.

### Cross-origin jump loses context (not-working case 3) — fix exists but unmerged

Test runs on custom domain `try.acme.com/offer` (served by SplitLab, snippet injected), goal = reach `/thanks`. The page links "Book now" → `acme.com/booking`, the client's **real** site on a different domain.

1. On `try.acme.com/offer` the snippet saves the test context into **`try.acme.com`'s** localStorage.
2. Visitor clicks through to `acme.com/booking`. Browsers isolate localStorage per origin, so nothing saved on `try.acme.com` is visible on `acme.com`.
3. tracker.js on `acme.com` finds no `?sl_vid` in the URL and an empty localStorage → concludes the visitor is in no test and goes idle.
4. Visitor reaches `acme.com/thanks` — **no conversion recorded.**

**Status:** a fix was already built on branch **`conversion-url-fixes`** (2026-07-13) but was **never merged** into `development` or `main`:

- `7b4fb22` — tracker.js auto-decorates outbound links, forms, and `window.open` with sl params (redirect mode)
- `c55de6f` — adds the same cross-domain linker to the inline HTML-page snippet

Until that branch is merged, the code on `development` still carries the "not implemented yet" comment (`src/lib/tracking.ts:72-75`) and this case remains broken. Merging `conversion-url-fixes` turns it into a working case.

## Cross-domain edge cases (from the `conversion-url-fixes` branch)

The `conversion-url-fixes` branch adds a GA4-style cross-domain linker: when the visitor navigates to a different domain, the tracking context (`sl_tid`/`sl_vid`/`sl_vh`) is appended to the destination URL. tracker.js on the destination rebuilds context from those params (detect Method 1, now also fetching goals via `/api/resolve` so `url_reached` patterns can fire there) and strips them from the URL. Implemented in **both** modes:

- **Redirect mode** — tracker.js on the client's site (`7b4fb22`)
- **HTML mode** — the inline snippet on SplitLab-hosted pages (`c55de6f`)

### Covered navigations ✅

1. **Link clicks** (`<a href>`), including new-tab opens — decorated on `mousedown`, `auxclick` (middle-click), and `click` in capture phase, so every click variant is caught before the browser follows the link.
2. **Form submits to another domain** — POST forms get a decorated `action`; GET forms get hidden `sl_tid`/`sl_vid`/`sl_vh` inputs instead (a GET submit replaces the action's query string with form fields, so query params alone would be dropped). Reads `action` via `getAttribute` so an input named "action" can't shadow it.
3. **`window.open(url)`** — `window.open` is monkey-patched to decorate the URL first.

Safety rails in `decorate()`: only `http:`/`https:` URLs, same-hostname URLs skipped (localStorage already covers those), and URLs that already carry `sl_vid`/`sl_tid` are left alone (no double-decoration).

### NOT covered ❌

1. **JS-driven redirects via `window.location.href = url`** (also `location.assign()` / `location.replace()`) — the `location` object cannot be intercepted or monkey-patched by any script, so these navigations leave undecorated. The planned solution is a manual escape hatch in tracker.js — `SplitLab.go(url)` (which does `window.location.href = decorate(url)`) plus a public `SplitLab.decorate(url)` — the page's own JS calls it instead of setting `location.href` directly, the same way GA handles this. **The code for this already exists in `7b4fb22` but is commented out/disabled** — it needs to be enabled (and possibly complemented by the Navigation API where supported) as part of v2.
2. **PROXY mode cross-domain — completely unaddressed.** None of the linker work applies to proxy-mode redirect variants: the visitor stays on the wrapper URL while the real site runs inside the iframe, the iframe's storage is partitioned by the browser, and no decoration happens on navigations inside the iframe. Cross-domain conversion tracking for proxy mode remains entirely unsolved.
3. Other undecoratable navigation paths (same root cause as #1): `<meta http-equiv="refresh">`, server-side redirects from the destination page, and navigations triggered inside third-party widgets.

### Status

Both linker commits live only on `conversion-url-fixes` — not yet merged into `development`, `main`, or `url-conversion-v2`. V2 work: merge the linker, enable `SplitLab.go(url)` / `SplitLab.decorate(url)`, and design a solution for proxy mode.

## Missing cross-domain edge cases (v2 checklist)

Same-domain cases above are verified; cross-domain has only been code-reviewed, not tested. Based on what the linker actually handles, these are the open gaps.

### Not handled at all

1. **JS redirects** — `window.location.href` / `location.assign()` / `location.replace()` cannot be intercepted by any script. The `SplitLab.go(url)` / `SplitLab.decorate(url)` escape hatch exists in `7b4fb22` but is **commented out**; enable it and document it for clients.
2. **Proxy mode cross-domain — the entire category.** The linker doesn't touch the iframe: inner-page navigations can't be decorated, iframe storage is partitioned by browsers, and the wrapper URL never changes. Completely unsolved.
3. **Meta-refresh and server-side redirects** on the destination — `sl_*` params survive only if the redirect forwards the query string, which most don't.
4. **Destination domain without tracker.js** — decoration is useless if nothing on the destination reads the params. Every cross-domain hop requires tracker.js installed there; no fallback exists.
5. **Third-party embedded widgets** (Calendly/Typeform iframes on the destination page) — the conversion happens inside a cross-origin iframe and never surfaces as a URL on the destination domain, so `url_reached` can't see it.

### Handled in code but never tested

6. **Chained cross-domain context overwrite** — the single-slot `sl_tracking` bug is reachable cross-domain too: arrive on domain B with Test A's params, later arrive with Test B's params → Test A's context erased on B.
7. **Destination strips unknown query params** — routers/canonical redirects may drop `sl_*` before tracker.js runs; context silently lost.
8. **GET-form hidden inputs** — verify the destination's tracker picks up `sl_tid`/`sl_vid`/`sl_vh` submitted as form fields, and that they don't pollute the site's own form processing.
9. **Shadow DOM links** — `e.target.closest('a[href]')` may not reach anchors inside shadow roots (event retargeting); links in web components could go undecorated.
10. **Copy-link / drag-to-tab** — copying a link via context menu doesn't navigate, so the copied href is undecorated; pasted in a new tab, context is lost. Minor but real.
11. **Safari ITP** — script-written localStorage is capped at ~7 days in Safari; the 90-day context TTL silently shrinks, so late conversions on the destination are lost there.
12. **Pageview attribution after a decorated hop** — detect Method 1 fires a `pageview` for the origin test from the destination domain; per visitor/test/day dedup should keep counts sane, but the analytics implications haven't been checked.
13. **`www` vs naked domain** — `decorate()` treats different hostnames as cross-domain, which incidentally fixes the www/naked localStorage split; behavior never explicitly tested.

### Related fixes already on `conversion-url-fixes`

- `c2c9963` — dashboard respects a manual redirect-mode choice; the frameable check may only downgrade proxy → redirect, never override an explicit redirect choice.
- `2ea6795` — slug preview routes relay serve's 302 to the browser instead of following it server-side, fixing broken assets and wrong-origin tracking for redirect variants.

## Key code locations

- Goal schema: `supabase/migrations/001_initial_schema.sql` (`conversion_goals`, type `url_reached`, `url_pattern`)
- Snippet URL-goal check + cross-page `sl_ctx` persistence: `src/lib/tracking.ts` (`checkUrlGoals`, `saveCtx`, `checkStoredUrlGoals`)
- tracker.js context resolution + URL goals: `src/app/tracker.js/route.ts` (`detect`, `checkUrlGoals`, `wireUrlGoals`)
- Goal delivery to tracker.js: `src/app/api/resolve/route.ts`
- Serve-side caveat comments: `src/app/api/serve/route.ts` (proxy mode ~line 200, 302 redirect ~line 280)
