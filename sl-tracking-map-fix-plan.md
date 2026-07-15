# Plan: Fix chained-tests context overwrite in tracker.js

**Status: IMPLEMENTED on `url-conversion-v2` (2026-07-15) — all steps done, verified by simulation against the emitted tracker script.**

## The bug

tracker.js stores the visitor's test context in a single localStorage slot (`sl_tracking`). When a visitor enters Test A and later enters Test B on the same client domain, Test B's context **overwrites** Test A's. If the visitor then reaches Test A's conversion URL (`url_reached` goal), nothing fires — Test A's conversion is silently lost. The loss is biased: the earlier test always loses.

The inline snippet (`src/lib/tracking.ts`) already solved this with a per-test map (`sl_ctx` + `saveCtx()` / `checkStoredUrlGoals()`). This plan ports that pattern into tracker.js.

**Only file changed: `src/app/tracker.js/route.ts`.** No DB, no API routes, no dashboard, no snippet changes.

## Design decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Storage shape | `sl_tracking = { [testId]: { vid, vh, ts, goals } }` | Mirrors snippet's `sl_ctx` |
| Current test | Most-recent-by-`ts` entry | Preserves today's single-slot behavior; wrong pick would mis-attribute forms/leads |
| ctx shape to `boot()` | Unchanged `{ tid, vid, vh, goals }` | boot, scan mode, `__SL_SNIPPET__` stand-down never notice |
| Stored-goal check | Skip `tid === current test` | Current test's own `checkUrlGoals()` already covers it; skipping prevents double-fire |
| Dedup | In-memory, per page-load only (like snippet's `_sentStored`) | Persisting would change raw goal-hit counts / analytics goal-hits toggle |
| TTL | 90 days, pruned on load | Matches snippet's `CTX_TTL` and `sl_visitor` cookie |
| Migration | Old flat `{tid, vid, vh}` → wrapped as `{ [tid]: {...} }`, converted on first read, before any validation or save | Otherwise every returning visitor silently loses context on deploy day |

## Steps

### 1. Per-test map storage
- `store(ctx)`: read map, prune expired, write `m[ctx.tid] = { vid, vh, ts: Date.now(), goals }`, save.
- `load()`: read map (after migration + pruning), pick entry with newest `ts`, return as `{ tid, vid, vh, goals }`. Return `null` if empty — same as today.

### 2. Old-format migration (inside the read path, before validation)
- If parsed value has top-level `tid`/`vid`/`vh` (old flat object) → convert to `{ [tid]: { vid, vh, ts: now, goals: goals||[] } }` and re-save.
- Runs once per visitor; harmless no-op afterwards.

### 3. detect()/boot()
- No shape change needed — `detect()` callbacks already produce `{ tid, vid, vh, goals }`; only `store()`/`load()` internals change.
- Verify every `store(ctx)` call site (detect Methods 1–3, `boot()`) still passes a full ctx.

### 4. Stored URL-goal checking (port from snippet)
- New `checkStoredUrlGoals()`: iterate all map entries where `tid !== _ctx.tid`; for each `url_reached` goal, regex-test current URL; on match, `send()` a conversion with **that entry's** `vid`/`vh` (not the current test's).
- Wire into `wireUrlGoals()` so it runs on initial load + pushState/replaceState/popstate/hashchange.
- Guard with `_sentStored[goalId]` (in-memory) so one page-load fires each stored goal once.
- Skip entirely in scan mode (`sl_scan=1`), matching the snippet.

### 5. TTL pruning
- On every map read: drop entries where `now - ts > 90 days`; re-save only if something was dropped.

### 6. Regression verification (before calling it done)
Single-test flows must behave exactly like today:
- 302 landing with `?sl_vid` → context stored, pageview fired, goals fetched
- Returning visitor (no params) → context loaded from localStorage
- Form submit / button click / call click goals + lead capture attribution
- Scan mode end-to-end
- Stand-down when `__SL_SNIPPET__` is present
- Old-format localStorage value from before the deploy → migrated, context kept

### 7. Chained-scenario verification (the actual fix)
- Visitor enters Test A, then Test B (same domain) → reaches Test A's conversion URL → **Test A conversion recorded** with Test A's variant/visitor; Test B untouched.
- Then reaches Test B's conversion URL → Test B recorded.
- Shared-goal-URL case: both tests watch `/thanks` → both credited.
- Confirm no double-fire for the current test's own goals.

### 8. Docs
- Update `url-conversion.md`: move chained-redirect-variants from not-working to working; note the map migration.

## Risk assessment

- **Blast radius:** tracker.js only (client-site installs). Everything is inside `try/catch`; worst failure mode = tracker goes idle on that page, identical to today's behavior when no context exists. Client sites cannot break.
- **Expected metric change:** conversion counts rise (previously-lost conversions now recorded) — by design; worth a heads-up to stakeholders comparing dashboards.
- **The three failure traps and their guards:** migration order (step 2 runs before validation/save), current-test pick (most-recent-by-ts), double-fire (skip current tid). Each is explicitly locked above.

## Out of scope

- Cross-domain linker merge (`conversion-url-fixes` branch) — separate task
- Enabling `SplitLab.go()` / `SplitLab.decorate()` — separate task
- Proxy-mode conversion tracking — unsolved, separate design effort
