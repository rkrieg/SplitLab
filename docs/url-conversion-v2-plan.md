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

## ✅ PRIORITY 0 — Verify same-domain PROXY mode (no code, just test)

This is the biggest open unknown. `url-conversion-cases.md §3` marks it ⚠️ "should work, not yet live-tested." Settle it before writing any code.

- [x] Set a **proxy-mode** test pointing at your own multi-page site (e.g. hunbalsiddiqui.com/offer-a.html), goal = reach `/thanks.html`. Destination already has `dev.trysplitlab.com/tracker.js`.
- [x] Open the test URL (proxy wrapper) in **Chrome**. Click the internal link to `/thanks.html` **inside the iframe**.
- [x] Watch Network for `POST /api/event 200` with a `conversion` payload (correct testId/variantId/goalId). **✅ fired 200, correct test/variant/goal.**
- [x] Repeat the click via `window.location.href = "/thanks.html"` inside the iframe (Case A, same-origin) — confirm it still fires. **✅ fired.**
- [x] Repeat the whole test in **Safari** — this is the fragile one (ITP may block third-party-iframe `localStorage`). **✅ PASSED — conversion fired. Safari ITP did NOT block the iframe's localStorage.**
- [x] **Record results in `url-conversion-cases.md §3`**: Chrome ✅ CONFIRMED, Safari ✅ CONFIRMED.

**Result:** ✅ **Proxy same-domain CONFIRMED on Chrome AND Safari (2026-07-16)** — tracker.js inside the iframe reads its partitioned localStorage and fires `url_reached` conversions. The predicted Safari-ITP storage-blocking risk did **not** materialise. No Storage Access API / postMessage bridge needed.
**Note:** the stale-entry 500s seen during this test are the Priority 0.5 bug (deleted tests in `sl_tracking`); the current test itself fired 200.

---

## ✅ PRIORITY 0.5 — Fix `/api/event` 500 on conversions for deleted tests — DONE

**What's happening (surfaced during the Priority 0 proxy test):** the `sl_tracking` localStorage map keeps each test's context for 90 days. Our `checkStoredUrlGoals()` cross-test checker fires a conversion for **every** stored test whose `url_reached` pattern matches the current URL. If one of those stored tests was **deleted** from the DB, `/api/event` tries to insert an `events` row whose `test_id` / `variant_id` / `goal_id` reference no-longer-existing rows → Postgres **foreign-key violation (code `23503`)** → the route's `if (error) throw error` → **HTTP 500**.

Observed live: current proxy test (`3d975c36…`) fired pageview + conversion **200** (feature works ✅), but two stale entries from earlier deleted tests (`05ad1943…`, `7aa0293c…`) fired conversions that **500'd**. Harmless to the visitor (fire-and-forget `sendBeacon`), but real 500 noise in production for any visitor holding a stale entry.

**Fix:** in `src/app/api/event/route.ts`, treat an FK violation (`23503`) on the events insert as a **soft no-op → 200 `{ ok: true, stale: true }`** instead of throwing 500. The stored entry points at a deleted test; dropping it silently is correct.

- [x] Add the `23503` guard around the `events` insert (only that error code → 200; everything else still throws → 500). **DONE** — `src/app/api/event/route.ts`.
- [x] `npm run build` — **passes**.
- [x] Code-verified against schema (`events.test_id`/`variant_id` are NOT NULL FK `ON DELETE CASCADE` → deleted test ⇒ `23503`); guard catches only `23503`, Zod still 400, other errors still 500, normal path untouched.
- [x] **LIVE-VERIFIED on dev (2026-07-16):** conversions for the **deleted** tests `05ad1943…` (goal `077571ee…`) and `7aa0293c…` (goal `c573884d…`) now return **200** — the exact payloads that returned **500** before the guard. Confirms the `23503` soft no-op works in production conditions.
- [x] **Fresh valid conversion still returns 200** — current test `3d975c36…` pageview + conversion both 200. Normal path untouched.
- [x] Confirmed dev **does** deploy from `url-conversion-v2` (an earlier assumption that it served `development` was wrong).

**Note — why the server guard is the right fix:** the stale entries kept firing even *after* `localStorage.removeItem('sl_tracking')` on the destination origin. You cannot rely on clearing visitors' browsers; the server has to shrug these off. Response bodies aren't visible in DevTools for these calls because tracker.js uses `navigator.sendBeacon` (fire-and-forget) — status codes are still accurate.

---

## PHASE 1 — tracker.js: the RECEIVER (all modes) + redirect-mode linker — from `7b4fb22`

> **⚠️ Phase naming corrected 2026-07-16.** The old title said "Redirect-mode …", which is misleading and caused a wasted test cycle. The real split is **sender vs receiver**, not redirect vs HTML:
>
> | Mode | Sender (attaches params) | Receiver (fires the conversion) |
> |---|---|---|
> | HTML | inline snippet `tracking.ts` — **Phase 2** | **tracker.js — Phase 1** |
> | Redirect | tracker.js on the client's page — **Phase 1** | **tracker.js — Phase 1** |
> | Proxy | whichever runs inside the iframe | **tracker.js — Phase 1** |
>
> **tracker.js is the receiver for every mode**, because it is what runs on the destination site. So `7b4fb22` contains two independent things:
> 1. **Decoration (sender)** — genuinely redirect-mode only. HTML mode doesn't need it.
> 2. **Method-1 goal fetch (receiver)** — needed by **every** mode. This is the blocking piece.
>
> **Why this matters:** on `url-conversion-v2`, [tracker.js Method 1](../src/app/tracker.js/route.ts#L971) does `return callback({ tid, vid, vh, goals: [] })` — **goals is empty**. Only Method 2 (`/api/resolve`) fetches goals. So a decorated cross-domain link lands on the destination, tracker.js rebuilds context correctly… and has **no goals to match**, so `url_reached` can never fire. `7b4fb22` replaces that line with an XHR to `RESOLVE_URL` — its own comment says *"Fetch goals so url_reached patterns can fire on this page too (params may arrive via cross-domain link decoration, not just a SplitLab 302)"*.
>
> **Consequence: Phase 2 alone can never produce a cross-domain conversion.** It attaches params perfectly (Stage 1: 13/13 PASS) but nothing on the far side reads them. **Live-confirmed 2026-07-16** — Stage 2 failed for exactly this reason, not a linker bug.

**Split into 1A (receiver) and 1B (sender)** — deliberately, because only 1A is needed by every mode. Doing 1A alone unblocks HTML cross-domain without touching redirect-mode behaviour at all.

### PHASE 1A — Method-1 goal fetch (the receiver) — **CODE DONE, awaiting live test**

The only blocking piece. Replaces the `goals: []` line with an XHR to `/api/resolve` so a destination that receives decorated params can actually match `url_reached` patterns.

- [x] Hand-port **only** the Method-1 goal-fetch hunk from `7b4fb22` — **DONE**, `src/app/tracker.js/route.ts`, then **reworked to be non-blocking** (see below).

> **⚠️ Deviation from `7b4fb22` — deliberate, and it matters.** The original commit made Method 1 **await** `/api/resolve` before `callback()`, turning a synchronous boot into a blocking one. Measured live on dev 2026-07-16:
>
> ```
> run 1: 1.95s (cold)   run 2: 1.07s   run 3: 1.07s   run 4: 1.10s   run 5: 1.28s
> ```
>
> `connect` was only 30-70ms while `ttfb` was the whole ~1.07s — the latency is `/api/resolve` itself (Supabase query), not the network. **~1 second is far too long to block on**, and it would have delayed **every redirect-mode pageview**, not just cross-domain ones — losing them outright whenever a visitor bounces inside that first second. Redirect-mode visitors have just been 302'd, so a sub-second bounce is entirely normal. `7b4fb22` almost certainly never measured this.
>
> **Our version instead:** `callback()` fires **immediately** with `goals: []` (pageview timing identical to today), and `fetchGoalsLate(vid)` fills goals in afterwards, then re-runs `checkUrlGoals()`. `url_reached` still fires — roughly a second later, which is irrelevant for a URL-match goal. **No pageview risk.**
>
> Safe because: `track()` dedups via `_sent`, so the second URL check cannot double-fire; `_ctx` is set synchronously at the top of `boot()`, so it always exists when the XHR returns; `store(_ctx)` re-persists the goals into `sl_tracking`; a resolve failure simply leaves `goals: []` — today's exact behaviour; and `if (_scanMode) return` keeps Method-1 scan behaviour byte-for-byte unchanged.
- [x] **Verify it is receiver-only, no sender.** Confirmed: `grep` for `decorate` / `decorateLink` / `patchWindowOpen` / `auxclick` / `SplitLab.go` / `watchNavigations` in tracker.js returns **NONE**. Decoration deliberately **not** ported — HTML mode doesn't need it (its sender is the snippet, Phase 2).
- [x] **Diff is `+31 / −1`**, confined to the Method-1 branch of `detect()` plus the new `fetchGoalsLate()` helper. Nothing else in tracker.js touched.
- [x] **Per-test map fix intact** — `STORAGE_KEY = "sl_tracking"` and the map logic untouched.
- [x] **Method-1 context does get persisted** — `boot()` calls `store(_ctx)` ([tracker.js:1063](../src/app/tracker.js/route.ts#L1063)), so the goals fetched here land in `sl_tracking` and later same-domain navigations on the destination keep working.
- [x] `npm run build` — **passes**.
- [ ] ⚠️ **Deploy to dev** — the fix was **local-only/uncommitted**; `HEAD` had no `xhr0`, which is exactly why the 2026-07-16 Stage 2 attempt failed. It must be committed + pushed before re-testing.
- [ ] **Re-run Phase 2 Stage 2** — HTML hosted page → `hunbalsiddiqui.com/thanks.html`: conversion fires `200` with correct test/variant/goal.
- [ ] **Regression R1–R5** (same-domain redirect) — tracker.js changed, so re-verify the map fix still holds.
- [ ] **Regression: redirect-mode 302** — the original Method-1 path. Confirm the pageview still fires **immediately** (no ~1s delay — that was the whole point of going non-blocking) and exactly **once**.
- [ ] **Regression: no double-fire** — the goals arriving late trigger a second `checkUrlGoals()`. `_sent` should dedup; confirm one conversion, not two, when the landing page itself matches the goal pattern.
- [ ] **Regression: `/api/resolve` slow or down** — pageview must still fire on time; a failed fetch just leaves `goals: []` (today's behaviour). Confirm an outage degrades rather than breaks.
- [ ] **Regression: Method-1 + `sl_scan=1`** — `fetchGoalsLate` is scan-guarded; confirm scanning still fires no conversions.
- [ ] Update `url-conversion-cases.md §2` + `url-conversion-failing-cases.md §A`: HTML cross-domain link / form / `window.open` → ✅.

### PHASE 1B — redirect-mode decoration (the sender) — **NOT DONE, deferred**

`decorate()`, `decorateLink()`, `patchWindowOpen()`, `mousedown`/`auxclick` listeners, form-action decoration inside tracker.js. **Redirect mode only** — HTML mode does not need this.

- [ ] Port the decoration half of `7b4fb22`.
- [ ] `npm run build`
- [ ] **Test cross-domain link** (`<a href>`, incl. new tab / middle-click) site A → site B (both have tracker.js).
- [ ] **Test cross-domain form** (POST decorates `action`; GET adds hidden inputs).
- [ ] **Test `window.open(url)`** cross-domain.
- [ ] Regression: same-domain redirect cases **R1–R5** still pass.


---

## PHASE 2 — HTML-mode cross-domain linker (inline snippet) — from `c55de6f`

**Why this is needed (root cause, code-verified 2026-07-16):** `localStorage` is **per-origin**. The snippet stores context in `sl_ctx` ([tracking.ts:76-103](../src/lib/tracking.ts#L76-L103)), and `checkStoredUrlGoals()` ([tracking.ts:111](../src/lib/tracking.ts#L111)) reads it back after any navigation. Same-domain that just works — the context is already in that origin, no interception needed. Cross-domain the destination origin sees an **empty** `sl_ctx`: no test, no variant, no goal ⇒ no conversion. The file's own comment says it at [tracking.ts:73](../src/lib/tracking.ts#L73): *"localStorage is per-origin: this does NOT work across different domains."* Fix = carry context in the URL (`sl_tid`/`sl_vid`/`sl_vh`); destination tracker.js rebuilds it via detect **Method 1** and strips the params.

**What `c55de6f` adds** — 76 lines, **purely additive** (`+76 / −0`), only inside `buildTrackingSnippet`. Verified: cherry-picks **cleanly** onto `url-conversion-v2`, and does **not** touch `sl_ctx` / `checkStoredUrlGoals` / the per-test map.

| Function | Job |
|---|---|
| `decorate(url)` | Appends `sl_tid`/`sl_vid`/`sl_vh`. Skips: non-http(s), **same hostname**, already-decorated |
| `decorateFromEvent(e)` | `closest('a[href])` → rewrite `href` before the browser follows it |
| `decorateFormForSubmit(form)` | POST → rewrite `action`; GET → **hidden inputs** (GET wipes the action query string) |
| `patchWindowOpen()` | Wraps `window.open`, decorates arg 0, `__sl_patched` guards double-wrap |

Hooks: `mousedown` + `auxclick` + `click` (all **capture phase**, so they run before the navigation; `auxclick` covers middle-click new-tab). Form hook goes on the existing global `submit` listener. Everything is gated behind `if (!_isScan)` so dashboard goal-scanning is unaffected.

### Todos

- [x] Cherry-pick `c55de6f` onto `url-conversion-v2` — **DONE**, `git cherry-pick -n c55de6f`, clean auto-merge, no conflicts. **Staged, NOT committed** (per instruction).
- [x] Confirm the diff is `+76 / −0` on `src/lib/tracking.ts` only, and `sl_ctx` + `checkStoredUrlGoals` are byte-identical. **VERIFIED** — `git diff --numstat` = `76  0  src/lib/tracking.ts`; deletion-line count is literally **0**; lines 60-135 (the `sl_ctx` map + `checkStoredUrlGoals`) diff **IDENTICAL** against HEAD.
- [x] `npm run build` — **PASSES**.
- [ ] ⛔ **BLOCKED ON PHASE 1** — **Test cross-domain link** hosted page → second domain: params land ✅ (proven), but the conversion **cannot** fire until tracker.js Method 1 fetches goals. Attempted live 2026-07-16 against `hunbalsiddiqui.com/thanks.html` (tracker.js installed, `url_reached` goal set): **no conversion**, exactly as the `goals: []` line predicts. Re-run immediately after cherry-picking `7b4fb22`.
- [ ] **Test new-tab / middle-click** on the same link (this is what `auxclick` exists for).
- [ ] **Test cross-domain form** — POST (decorated `action`) **and** GET (hidden inputs) separately; they take different code paths.
- [ ] **Test `window.open(url)`** cross-domain.
- [x] **Test the skip rules:** same-domain link is **not** decorated; `mailto:` / `tel:` / `#anchor` untouched; already-decorated URL isn't double-tagged. **✅ ALL PASS live on dev (2026-07-16)** — see Stage 1 below.
- [ ] **Regression: same-domain HTML cases H1–H5 still pass** — especially H2/H5 (chained hosted tests via `sl_ctx`) and H3 (no double-fire).
- [x] **Regression: dashboard goal scan** (`?sl_scan=1`) — linker stays dormant. **✅ PASS live on dev (2026-07-16)** — with `sl_scan=1` every decoration assertion inverted (nothing tagged: link, hunbalsiddiqui link, POST action, GET hidden inputs all clean) and `window.open.__sl_patched === undefined`, i.e. `window.open` was never wrapped. The `!_isScan` gate holds; the goal scanner is unaffected.
- [ ] Update `url-conversion-cases.md §2` + `url-conversion-failing-cases.md §A`: HTML cross-domain link / form / `window.open` → ✅.

### Stage 1 — decoration, LIVE on dev 2026-07-16: **13/13 PASS** ✅

Harness: `linker-test.html` (repo root), served as an HTML-mode test via `dev.trysplitlab.com/linker-html/e877ed20-…`. Every assertion runs client-side without navigating, so decoration is observed directly.

| Check | Result |
|---|---|
| cross-domain link decorated (3 params) | ✅ |
| same-domain link **NOT** decorated | ✅ (`dev.trysplitlab.com/internal`, clean) |
| `mailto:` / `tel:` / `#anchor` untouched | ✅ |
| second cross-domain host (hunbalsiddiqui.com) decorated | ✅ |
| idempotent — no double-tag on repeat mousedown | ✅ |
| `window.open.__sl_patched === true` | ✅ |
| click-only path (keyboard Tab+Enter) decorated | ✅ |
| POST form: `action` decorated | ✅ |
| GET form: `action` **NOT** rewritten | ✅ |
| GET form: 3 hidden inputs added | ✅ (`sl_tid,sl_vh,sl_vid`) |
| GET form: hidden inputs **not duplicated** on re-submit | ✅ (count stays 3) |

**Confirms the two riskiest paths:** GET vs POST are genuinely separate branches and both behave correctly, and the hidden-input guard prevents accumulation across repeat submits.

### Stage 3 — scan-mode regression, LIVE on dev 2026-07-16: **PASS** ✅

Same harness reloaded with `?sl_scan=1`. Every decoration assertion inverted exactly as required — cross-domain link, second-host link, POST `action`, GET hidden inputs (`count: 0`), click-only path: **all undecorated**. `window.open.__sl_patched` = `undefined`, so the patch never applied. The four negative assertions (same-domain / `mailto:` / `tel:` / `#anchor` must NOT decorate) stayed PASS in both modes, as they should.

**Verdict:** the `!_isScan` gate is airtight — dashboard goal scanning is unaffected by the linker.

**Still open:** Stage 2 — the real cross-domain conversion actually firing on the destination. Stage 1 only proves params are *attached*; Stage 2 proves the destination tracker.js *reads* them and posts the conversion.

### Edge-case audit (code-read 2026-07-16, before any live test)

**The one that mattered:** `decorateFormForSubmit` appends **hidden inputs** to GET forms at submit time, and it runs on the *same* global `submit` listener, **immediately before** `captureFormLead(e.target)` ([tracking.ts:546](../src/lib/tracking.ts#L546)). So the question was whether `sl_tid`/`sl_vid`/`sl_vh` could leak into lead data or corrupt the `fields:` goal selector. Traced every consumer — **all six skip `type === 'hidden'`**:

| Consumer | Risk if it saw our inputs | Skips hidden? |
|---|---|---|
| `captureFormLead` | `sl_tid` sent as a lead field | ✅ |
| `fieldsLookValid` | gates lead sending | ✅ |
| `snapshotVisibleFormFields` | stepper accumulation | ✅ |
| `registerFormFields` | dashboard field list | ✅ |
| `fieldKey` → `formFieldSignature` | **`fields:` selector would change ⇒ goal stops matching** | ✅ (both copies, L410 + L727) |

**Verdict: no leak, no selector drift.** The hidden inputs are invisible to every existing code path.

**Other guards confirmed:**
- **Idempotent** — [L148](../src/lib/tracking.ts#L148) returns early if `sl_vid`/`sl_tid` already present ⇒ repeated mousedown/click on the same link can't double-tag.
- **`mailto:` / `tel:` / `javascript:`** — [L146](../src/lib/tracking.ts#L146) http(s)-only ⇒ untouched.
- **`#anchor` / same-domain** — [L147](../src/lib/tracking.ts#L147) hostname equality ⇒ no param leak onto internal URLs.
- **Scan mode** — both the listener block ([L204](../src/lib/tracking.ts#L204)) and the form hook are behind `!_isScan` ⇒ dashboard goal-scan stays dormant.
- **Double-wrap** — `__sl_patched` flag ⇒ `window.open` can't be wrapped twice.
- **Everything wrapped in `try/catch`** returning the original url ⇒ a throw can't block a navigation.
- **Keyboard nav (Tab+Enter)** fires `click` but **not** `mousedown` — this is exactly why all three listeners exist. Covered.

### Notes / watch-outs

- **`window.location.href` is NOT fixed by this phase.** `location` cannot be intercepted by any script — no setter trap, no override. Stays ❌ until Phase 3 (manual `SplitLab.go`) or Phase 4 (`watchNavigations`).
- **Destination must have tracker.js.** Params with no reader = no conversion. This is why the second domain is a hard blocker.
- **Subdomain jumps get decorated.** The check is `u.hostname === window.location.hostname`, so `app.site.com` → `site.com` counts as cross-domain and gets tagged. Harmless (destination strips them) but worth knowing when reading URLs during testing.
- **`a.href` is mutated permanently in the DOM** ([L163](../src/lib/tracking.ts#L163)) — after a mousedown, a right-click → "Copy link address" yields the decorated URL, and the params stay if the navigation is cancelled. Cosmetic only (idempotent, destination strips them), but it's a visible side effect worth knowing about.
- **Decoration can't help a link whose own click handler `preventDefault()`s and then does `location.href = …`** — we rewrite the `href`, but the site never uses it. Same `location` wall as always.

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
