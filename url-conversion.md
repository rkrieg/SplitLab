# URL Conversion (`url_reached`) — Same-Domain Cases

How SplitLab's Conversion URL feature works, and which same-domain scenarios are supported. Verified against the code.

## How it works

A conversion goal of type `url_reached` stores a `url_pattern` (e.g. `/thanks`, `/booking`) in the `conversion_goals` table. A conversion fires when the visitor reaches a URL matching that pattern (case-insensitive regex, tested against both full `href` and `pathname + search`).

Two independent mechanisms check URL goals — **they do not share storage**:

| Mechanism | Where it runs | localStorage key | Cross-test aware? |
|---|---|---|---|
| Injected snippet (`src/lib/tracking.ts`) | SplitLab-served HTML pages (custom domain) | `sl_ctx` (per-test map) | Yes — `checkStoredUrlGoals()` fires other tests' saved goals |
| tracker.js (`src/app/tracker.js/route.ts`) | Client's own site (site-wide install) | `sl_tracking` (single slot) | No — only one test context at a time; never reads `sl_ctx` |

Key structural fact: on a custom domain, **every path** is rewritten by middleware to `/api/serve`, which only serves active tests. Any path without an active test returns 404 — there are no "plain pages" on a SplitLab custom domain.

## Working cases ✅

1. **HTML variant, SPA navigation** — pushState/replaceState/popstate/hashchange to `/thanks` within the same page; the snippet wraps history and re-checks its own URL goals.
2. **HTML variant → another SplitLab-served test page on the same custom domain** — test A's snippet saves context to `sl_ctx`; the destination page's snippet runs `checkStoredUrlGoals()` and fires test A's conversion with correct variant/visitor attribution (e.g. `/offer` → `/booking`).
3. **Redirect variant (proxy mode OFF) → client's real domain with tracker.js installed site-wide** — tracker.js resolves `?sl_vid` via `/api/resolve`, stores context in `sl_tracking`; when the visitor reaches `/thanks` on that same origin, tracker.js boots from localStorage and fires the goal. Requires **same origin** (www vs naked domain / subdomains break localStorage sharing).
4. **Dashboard preview URLs** — the catch-all route (`/[slug]/[testId]/[...rest]`) keeps trailing segments in the browser URL so patterns like `/booking` match (note: Open-button previews with `sl_vh` inject no tracking snippet, so no events fire).

## Not working cases ❌

1. **HTML variant → same-domain path with no active test** — the page itself 404s (serve finds no test); nothing checks `sl_ctx`. Workaround: create a test (even single-variant) at the destination path.
2. **Chained redirect variants on the same client domain** — `sl_tracking` is single-slot; resolving test B's `sl_vid` overwrites test A's context, so test A's URL conversion is silently lost. *(See detailed explanation below.)*
3. **Redirect variant with proxy mode ON (iframe wrapper)** — the wrapper URL never changes as the visitor navigates inside the iframe, and browsers partition third-party iframe storage. Note: `proxy_mode` **defaults to ON**; case 3 above only applies when it's explicitly off.
4. **Cross-origin navigation** — HTML variant linking out to the client's real site: the custom domain's localStorage isn't visible there, and `sl_vid` isn't appended to outbound links on this branch. *(A fix exists on an unmerged branch — see detailed explanation below.)*

## Missed conversions — detailed explanations

### Chained redirect variants overwrite each other (not-working case 2)

tracker.js on the client's site remembers "which test is this visitor in" using a **single localStorage slot** (`sl_tracking`). It can only hold **one test's context at a time** — think of it as a whiteboard with room for one instruction.

Example, client site `acme.com` with tracker.js site-wide and two active tests:

- **Test A**: redirect variant → `acme.com/summer-sale`, goal = reach `/thanks`
- **Test B**: redirect variant → `acme.com/pricing`, goal = reach `/signup-done`

1. Visitor hits Test A → 302 to `acme.com/summer-sale?sl_vid=A123`. tracker.js resolves it and stores: *"Test A — watch for /thanks."*
2. Same visitor later enters Test B's flow → lands on `acme.com/pricing?sl_vid=B456`. tracker.js **erases the slot** and stores: *"Test B — watch for /signup-done."* Test A's context is gone.
3. Visitor reaches `acme.com/thanks` — exactly Test A's goal. tracker.js only knows about `/signup-done`, so it does nothing. **Test A's conversion is silently missed.**

Nothing errors — the second test just wipes the first test's memory. With only one test in play per visitor per domain, this never triggers. The inline snippet on SplitLab-hosted pages does NOT have this bug (its `sl_ctx` store is a per-test map), only tracker.js does. Fix would be making `sl_tracking` a per-test map like `sl_ctx`.

Code: `store()` / `load()` in `src/app/tracker.js/route.ts` (single `STORAGE_KEY = "sl_tracking"`).

### Cross-origin jump loses context (not-working case 4) — fix exists but unmerged

Test runs on custom domain `try.acme.com/offer` (served by SplitLab, snippet injected), goal = reach `/thanks`. The page links "Book now" → `acme.com/booking`, the client's **real** site on a different domain.

1. On `try.acme.com/offer` the snippet saves the test context into **`try.acme.com`'s** localStorage.
2. Visitor clicks through to `acme.com/booking`. Browsers isolate localStorage per origin, so nothing saved on `try.acme.com` is visible on `acme.com`.
3. tracker.js on `acme.com` finds no `?sl_vid` in the URL and an empty localStorage → concludes the visitor is in no test and goes idle.
4. Visitor reaches `acme.com/thanks` — **no conversion recorded.**

**Status:** a fix was already built on branch **`conversion-url-fixes`** (2026-07-13) but was **never merged** into `development` or `main`:

- `7b4fb22` — tracker.js auto-decorates outbound links, forms, and `window.open` with sl params (redirect mode)
- `c55de6f` — adds the same cross-domain linker to the inline HTML-page snippet

Until that branch is merged, the code on `development` still carries the "not implemented yet" comment (`src/lib/tracking.ts:72-75`) and this case remains broken. Merging `conversion-url-fixes` turns it into a working case.

## Key code locations

- Goal schema: `supabase/migrations/001_initial_schema.sql` (`conversion_goals`, type `url_reached`, `url_pattern`)
- Snippet URL-goal check + cross-page `sl_ctx` persistence: `src/lib/tracking.ts` (`checkUrlGoals`, `saveCtx`, `checkStoredUrlGoals`)
- tracker.js context resolution + URL goals: `src/app/tracker.js/route.ts` (`detect`, `checkUrlGoals`, `wireUrlGoals`)
- Goal delivery to tracker.js: `src/app/api/resolve/route.ts`
- Serve-side caveat comments: `src/app/api/serve/route.ts` (proxy mode ~line 200, 302 redirect ~line 280)
