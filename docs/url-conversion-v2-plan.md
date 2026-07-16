# URL Conversion v2 — Execution Plan & Test Todos

**Branch:** `url-conversion-v2`
**Goal:** Cover every URL-conversion case across **HTML**, **Proxy**, and **Redirect** modes (same-domain + cross-domain), porting the linker work from the local-only `conversion-url-fixes` commits, testing each slice live before moving on.

**Reference docs:**
- `url-conversion-cases.md` — the working/not-working matrix (H1–H5, R1–R5, proxy, `location.href`)
- `url-conversion-failing-cases.md` — the failing cases split by fix source
- `docs/url-conversion-tasks.md` — full target source (enhanced version) + the actual committed diffs

**Golden rule for every step:** `implement → npm run build → live-test the specific case → confirm green`

---

## ⚠️ Backup first (do before anything)

- [ ] Push the local-only linker branch so it's not one disk failure from gone:
  `git push origin conversion-url-fixes` (commits `7b4fb22` + `c55de6f` are LOCAL ONLY right now)

---

## PRIORITY 0 — Verify same-domain PROXY mode (no code, just test)

This is the biggest open unknown. `url-conversion-cases.md §3` marks it ⚠️ "should work, not yet live-tested." Settle it before writing any code.

- [ ] Set a **proxy-mode** test pointing at your own multi-page site (e.g. hunbalsiddiqui.com/offer-a.html), goal = reach `/thanks.html`. Destination already has `dev.trysplitlab.com/tracker.js`. 
- [ ] Open the test URL (proxy wrapper) in **Chrome**. Click the internal link to `/thanks.html` **inside the iframe**.
- [ ] Watch Network for `POST /api/event 200` with a `conversion` payload (correct testId/variantId/goalId). (worked till here)
- [ ] Repeat the click via `window.location.href = "/thanks.html"` inside the iframe (Case A, same-origin) — confirm it still fires.
- [ ] Repeat the whole test in **Safari** — this is the fragile one (ITP may block third-party-iframe `localStorage`).
- [ ] **Record results in `url-conversion-cases.md §3`**: flip ⚠️ → ✅ or ❌ per browser. Update `url-conversion-failing-cases.md` if proxy-same-domain proves broken.

**Expected:** Chrome/Firefox ✅ (stable partition), Safari ❓ (unknown — the reason we test).

---

## PRIORITY 0.5 — Fix `/api/event` 500 on conversions for deleted tests

**What's happening (surfaced during the Priority 0 proxy test):** the `sl_tracking` localStorage map keeps each test's context for 90 days. Our `checkStoredUrlGoals()` cross-test checker fires a conversion for **every** stored test whose `url_reached` pattern matches the current URL. If one of those stored tests was **deleted** from the DB, `/api/event` tries to insert an `events` row whose `test_id` / `variant_id` / `goal_id` reference no-longer-existing rows → Postgres **foreign-key violation (code `23503`)** → the route's `if (error) throw error` → **HTTP 500**.

Observed live: current proxy test (`3d975c36…`) fired pageview + conversion **200** (feature works ✅), but two stale entries from earlier deleted tests (`05ad1943…`, `7aa0293c…`) fired conversions that **500'd**. Harmless to the visitor (fire-and-forget `sendBeacon`), but real 500 noise in production for any visitor holding a stale entry.

**Fix:** in `src/app/api/event/route.ts`, treat an FK violation (`23503`) on the events insert as a **soft no-op → 200 `{ ok: true, stale: true }`** instead of throwing 500. The stored entry points at a deleted test; dropping it silently is correct.

- [x] Add the `23503` guard around the `events` insert (only that error code → 200; everything else still throws → 500). **DONE** — `src/app/api/event/route.ts`.
- [x] `npm run build` — **passes**.
- [x] Code-verified against schema (`events.test_id`/`variant_id` are NOT NULL FK `ON DELETE CASCADE` → deleted test ⇒ `23503`); guard catches only `23503`, Zod still 400, other errors still 500, normal path untouched.
- [ ] **Live-verify (morning):** re-run the proxy test with stale entries present → the previously-500 conversions now return 200 `{ stale: true }`.
- [ ] **Live-verify (morning):** a fresh valid conversion still returns plain 200.
- [ ] Note: clearing `localStorage.removeItem('sl_tracking')` in the test browser drops stale entries locally; the server guard is the real production fix.

---

## PHASE 1 — Redirect-mode cross-domain linker (tracker.js) — from `7b4fb22`

Port `decorate()`, `decorateLink()`, `patchWindowOpen()`, `mousedown`/`auxclick` listeners, form-action decoration, and Method-1 goal fetch. **Purely additive — does not touch the per-test map fix.**

- [ ] Cherry-pick or hand-port `7b4fb22` onto `url-conversion-v2`; resolve any minor textual conflict against the map code.
- [ ] `npm run build`
- [ ] **Test cross-domain link** (`<a href>`, incl. new tab / middle-click) site A → site B (both have tracker.js): params `sl_tid/sl_vid/sl_vh` land on B, conversion fires.
- [ ] **Test cross-domain form** (POST decorates `action`; GET adds hidden inputs).
- [ ] **Test `window.open(url)`** cross-domain.
- [ ] Regression: same-domain redirect cases **R1–R5** still pass (map fix intact).
- [ ] Update `url-conversion-cases.md §2` and `url-conversion-failing-cases.md §A`: flip these to ✅.


---

## PHASE 2 — HTML-mode cross-domain linker (inline snippet) — from `c55de6f`

Same decoration inside `buildTrackingSnippet` (`src/lib/tracking.ts`) for SplitLab-hosted pages.

- [ ] Cherry-pick / hand-port `c55de6f`.
- [ ] `npm run build`
- [ ] **Test** hosted page → external domain via link / form / `window.open`: params carry, conversion fires on destination (destination needs tracker.js).
- [ ] Regression: same-domain HTML cases **H1–H5** still pass.
- [ ] Update the two case docs (HTML cross-domain row → ✅).

---

## PHASE 3 — Enable `SplitLab.go` / `SplitLab.decorate` (manual escape hatch)

Uncomment the public API in **both** files (currently disabled — see `docs/url-conversion-tasks.md` lines 2403-2408).

- [ ] Uncomment `decorate` + `go` in tracker.js public API and the snippet equivalent.
- [ ] `npm run build`
- [ ] **Test:** a page that calls `SplitLab.go(otherdomain/url)` for a cross-domain jump → params carry, conversion fires.
- [ ] Document for clients: "use `SplitLab.go(url)` instead of `window.location.href = url` for cross-domain."
- [ ] Update `url-conversion-failing-cases.md §B` (cross-domain `location.href` → manual fix now available).
---

## PHASE 4 — `watchNavigations()` (Navigation API — auto `location.href`) — HIGHEST RISK

The enhanced-only piece (top of `docs/url-conversion-tasks.md`, not in the committed branch). Intercepts **every** navigation, so test hard.

- [ ] Port `watchNavigations()` into tracker.js + snippet; call it in boot.
- [ ] `npm run build`
- [ ] **Test (Chrome):** cross-domain `window.location.href` auto-decorates and conversion fires — client code unchanged.
- [ ] **Test `location.assign()` / `location.replace()`** cross-domain — also caught.
- [ ] **Regression (critical):** normal same-site navigation, downloads (`downloadRequest`), form navigations, and back/forward are **untouched** and nothing double-navigates.
- [ ] **Test old browser (Safari/Firefox):** falls back gracefully to manual `SplitLab.go` (no breakage when Navigation API absent).
- [ ] Update `url-conversion-cases.md §4` table: cross-domain `location.href` → ✅ auto (modern) / manual (old).

---

## PHASE 5 — Proxy cross-domain (only what's achievable)

Depends on Priority 0 + Phases 1–4 results.

- [ ] If proxy same-domain works: test whether the **inside-iframe linker** decorates a cross-domain jump from the client's site to another tracker-equipped domain (Phases 1–3 apply inside the iframe too).
- [ ] Document the hard limits that remain unsolvable: iframe → pure third-party (Calendly), sealed cross-origin iframe. Update `url-conversion-cases.md §3` / failing-cases §B accordingly.

---

## Full regression matrix to re-run at the end

Re-verify every row of `url-conversion-cases.md` on `url-conversion-v2` after all phases:

- [ ] HTML same-domain **H1–H5** ✅
- [ ] HTML cross-domain (link/form/window.open/`location.href`) — new
- [ ] Redirect same-domain **R1–R5** ✅
- [ ] Redirect cross-domain (link/form/window.open/`location.href`) — new
- [ ] Proxy same-domain (Chrome/Firefox/Safari) — from Priority 0
- [ ] Proxy cross-domain — documented limits
- [ ] Confirm no double-fire, no double-pageview, no double-lead across all modes

---

## Test environment needed

- **Same-domain tests:** hunbalsiddiqui.com pages + `dev.trysplitlab.com/tracker.js` (already set up).
- **Cross-domain tests:** ⚠️ need a **SECOND domain** with tracker.js installed as the destination. Arrange this before Phase 1.
- Test in **incognito** with the raw test URL (not the dashboard Open button — `sl_vh` injects no events).
- Watch **Network → `/api/event`** for `200` + correct payload; check dashboard analytics after.

---

## Risk notes

- Phases 1–3 are proven code from the branch (additive, low risk).
- Phase 4 (`watchNavigations`) is **new, unreviewed, affects all navigation** — keep it last and isolated so Phases 1–3 ship safely even if it's deferred.
- Every cross-domain hop **requires tracker.js on the destination** — no params-reader, no conversion.
