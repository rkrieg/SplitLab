# URL Conversion v2 — Session Handoff (2026-07-16)

Read this first, then `docs/url-conversion-v2-plan.md` for the full plan + per-test results.

**Branch:** `url-conversion-v2` (dev deploys from this branch — verified). Working tree clean, everything committed and deployed.

---

## The one rule that explains every case

- **Same-domain** — context already sits in that origin's `localStorage`. After any navigation the script reboots and reads it. **No interception needed**, so *every* navigation type works (link, `location.href`, typed URL, meta refresh).
- **Cross-domain** — `localStorage` never crosses origins, so context must **travel in the URL** (`sl_tid`/`sl_vid`/`sl_vh`). Something must *attach* those params before the jump. This is the only place things break.

## Sender vs receiver — the mental model that matters

Do **not** think "redirect mode vs HTML mode". Think **who attaches params** vs **who reads them**:

| Mode | Sender (attaches params) | Receiver (fires the conversion) |
|---|---|---|
| HTML | inline snippet (`src/lib/tracking.ts`) | **tracker.js** on the destination |
| Redirect | tracker.js on the client's page | **tracker.js** on the destination |
| Proxy | whichever runs inside the iframe | **tracker.js** on the destination |

**tracker.js is the receiver for every mode**, because it's what runs on the destination site. Mislabelling the plan's Phase 1 as "redirect-mode only" cost a wasted test cycle this session — HTML mode needed the tracker.js fix too.

**Both halves are always required.** A sender alone attaches params that nothing reads.

---

## What shipped this session (all live-verified on dev)

| Commit | What |
|---|---|
| `4f11941` | `/api/event` 500 → treat Postgres FK violation `23503` as soft no-op `200 {stale:true}` (stale 90-day `sl_tracking` entries posting for deleted tests) |
| `912ed86` | **Sender:** inline snippet decorates outbound links / form `action` / `window.open` with `sl_tid`/`sl_vid`/`sl_vh` (port of `c55de6f`) |
| `4022502` | **Receiver:** tracker.js Method 1 no longer returns `goals: []` — `fetchGoalsLate()` fetches goals from `/api/resolve` **after** boot, then re-runs `checkUrlGoals()` |
| `1927d89` | `__SL_SNIPPET__` guard so late-arriving goals can't double-fire alongside the inline snippet |

### Status now

| Case | Status |
|---|---|
| **Proxy same-domain** | ✅ **live: Chrome + Safari.** Safari ITP did NOT block the iframe's partitioned localStorage — no Storage Access API / postMessage bridge needed. (Earlier "unsolved" verdict was wrong: clients install tracker.js in their own source, it's mandatory.) |
| **HTML cross-domain link** | ✅ **live end-to-end** — conversion fired, dashboard count incremented |
| HTML cross-domain form / `window.open` | ⚠️ decoration verified live (13/13 harness), **end-to-end conversion not re-tested** |
| Redirect cross-domain | ❌ sender half (Phase 1B) deliberately not ported |
| Cross-domain `window.location.href` | ❌ **never auto-fixable** — `location` cannot be intercepted by any script. Needs Phase 3 (`SplitLab.go`) or Phase 4 (`watchNavigations`) |
| Proxy → pure third-party (Calendly) | ❌ genuine hard limit |

---

## Hard-won facts — do NOT re-derive these

1. **Redirect mode never reaches Method 1.** [`serve/route.ts:285-286`](../src/app/api/serve/route.ts#L285-L286) sets only `sl_vid` + `sl_vh`, **never `sl_tid`**. Method 1 needs `tid && vid && vh`, so redirect always takes **Method 2**. Method 1 is reached **only** via our cross-domain link decoration.
2. **`/api/resolve` costs ~1.07s** (measured 5×; `ttfb`-dominated ⇒ the Supabase query, not the network; ~1.95s cold). This is why `fetchGoalsLate` is non-blocking.
   - **Pre-existing, unrelated finding:** redirect mode's pageview genuinely *is* ~1s late today because Method 2 blocks on `/api/resolve`. **Not caused by us.** Worth its own ticket.
3. **SplitLab does not minify or flatten client HTML** — every path (`uploadHtml`, `POST /api/pages`, `PATCH /api/pages/[id]`, `from-html`, `serve`) stores/serves verbatim. The HTML field is a `<textarea>`. A client's `//` comments are safe. (A flattened test page this session caused a red-herring `SyntaxError`; cause was outside SplitLab.)
4. **`7b4fb22` + `c55de6f` are now pushed** — `origin/conversion-url-fixes` = `c55de6f`. The long-standing backup task is **done**.
5. **Hidden inputs are invisible to every form consumer.** `decorateFormForSubmit` appends hidden `sl_*` inputs to GET forms right before `captureFormLead`. All six consumers skip `type === 'hidden'` — including `fieldKey()` (both copies, L410 + L727) which feeds `formFieldSignature()` → the `fields:` goal selector. **No lead leak, no selector drift.** Verified by code read.

---

## Next tasks, in order

### 1. Finish the regressions (highest value — the linker is live and unproven against old behaviour)

- [ ] **R1–R5** same-domain redirect (link, `location.href`, typed URL, SPA pushState, chained tests) — tracker.js changed, so the per-test `sl_tracking` map fix needs re-confirming.
- [ ] **H1–H5** same-domain HTML (pushState goal, chained hosted tests, no double-fire).
- [ ] **Cross-domain form end-to-end** — POST (decorated `action`) and GET (hidden inputs) are separate code paths; test both.
- [ ] **Cross-domain `window.open`** end-to-end (click the button manually — a programmatic call gets popup-blocked).
- [ ] **`fields:` goal regression** — a `fields:`-selector form goal with a cross-domain GET action; confirm the goal still matches. This is the one case hidden inputs could have broken silently.

Harness: `linker-test.html` (repo root) — 13 self-checking assertions, `/* */` comments only (flatten-proof). Open via the **raw test URL** (`/<slug>/<testId>`) in **incognito** — *not* the dashboard Open button, which injects `sl_vh` and suppresses events.

### 2. Phase 1B — redirect-mode decoration (sender half of `7b4fb22`)

Unblocks redirect-mode cross-domain. Port `decorate()`, `decorateLink()`, `patchWindowOpen()`, `mousedown`/`auxclick` listeners, form-action decoration into tracker.js. Receiver half is already done.

### 3. Phase 3 — enable `SplitLab.go` / `SplitLab.decorate`

Exists in `7b4fb22`, commented out ("Disabled for now — uncomment to expose"). The only fix for cross-domain `location.href`. Then document for clients: *use `SplitLab.go(url)` instead of `window.location.href = url` for cross-domain.*

### 4. Phase 4 — `watchNavigations()` (Navigation API) — HIGHEST RISK, keep last

Auto-intercepts `location.href`. Enhanced-only (top of `docs/url-conversion-tasks.md`, never committed). Touches **all** navigation — regression-test downloads, form navigations, back/forward, and graceful fallback where the Navigation API is absent.

### 5. Phase 5 — proxy cross-domain

Test whether the inside-iframe linker decorates a cross-domain jump. Document the hard limits that remain.

---

## Working agreements

- **Golden rule:** `implement → npm run build → live-test the specific case → confirm green`.
- Don't run builds unless asked (the plan's build steps count as asked).
- Never use quotes/inverted commas in commit messages; one line, detailed, explains the *why*.
- Don't pre-implement features the user said to test first.
- `sendBeacon` is fire-and-forget — DevTools shows no response body. Status codes are still accurate; confirm real conversions in **dashboard analytics**.
- A `200 {stale: true}` means the `sl_tid` isn't in that DB — **not** a conversion.

## Doc map

| File | Purpose |
|---|---|
| `docs/url-conversion-v2-plan.md` | The plan, phases, and every test result |
| `url-conversion-cases.md` | Working/not-working matrix (H1–H5, R1–R5, proxy, `location.href`) |
| `url-conversion-failing-cases.md` | Failing cases split by fix source |
| `url-conversion.md` | Full mechanism write-up |
| `docs/url-conversion-tasks.md` | Two layers: enhanced/target source (with `watchNavigations` + live `SplitLab.go`) **and** the actual committed diffs |
| `linker-test.html` | The 13-assertion cross-domain harness |
