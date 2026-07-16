# URL Conversion (`url_reached`) — Working / Not-Working Cases

A quick-reference breakdown of every URL-conversion scenario across the three modes, splitby  **same-domain vs cross-domain** — because that split, not the mode, is what decides whether a conversion fires.

> **The one rule that explains everything**
>
> - **Same-domain** — the test context is already sitting in that origin's `localStorage`. After any full page load, tracker.js (or the inline snippet) simply re-boots and reads it. **No interception needed**, so *every* navigation type works — link, `window.location.href`, typed URL, meta refresh.
> - **Cross-domain** — the context must **travel inside the URL** (`sl_tid`/`sl_vid`/`sl_vh`). Something has to *add* those params before the jump. This is the only place things break — and `window.location.href` is the one navigation we can never auto-decorate, because the `location` object cannot be intercepted by any script.

---

## 1. SAME-DOMAIN — everything works ✅

### HTML mode (SplitLab-hosted pages, inline snippet)

All verified via code + simulation.

| # | Case | Result | Verified how |
|---|---|---|---|
| H1 | SPA navigation (`pushState` → `/booking`) fires own test's goal | ✅ Works | Simulated against the real emitted snippet — fired exactly once on pushState, none before |
| H2 | Hosted page (Test X) → full navigation → another hosted test page (Test Y): X's goal fires on Y's page | ✅ Works | Simulated — `sl_ctx` saved Test X's context; Y's snippet's `checkStoredUrlGoals()` fired X's conversion with X's own variant (`varX2`) |
| H3 | No double-fire: current test's own page matches its goal URL, stored pass doesn't duplicate it | ✅ Works | Simulated — exactly 1 conversion |
| H4 | popstate / hashchange navigations also re-check | ✅ Works | Same wiring as H1 (wrapped history + listeners), code-verified |
| H5 | Chained hosted tests (X then Y, then X's goal URL) | ✅ Works | Same mechanism as H2 — `sl_ctx` was always a per-test map, never had the single-slot bug |

### Redirect mode (destination has mandatory tracker.js, same origin)

| # | Navigation to the goal URL (same domain) | Result |
|---|---|---|
| R1 | Link click `<a href="/thanks">` | ✅ Works |
| R2 | `window.location.href = "/thanks"` | ✅ Works |
| R3 | Typed URL / bookmark / meta refresh | ✅ Works |
| R4 | SPA pushState / replaceState to `/thanks` | ✅ Works |
| R5 | Chained tests (A then B, then A's goal URL) | ✅ **CONFIRMED live 2026-07-16** — two tests coexisted as separate `sl_tracking` keys; A's entry untouched by B's write (`ts` unchanged), and A's goal URL fired A's own variant. The per-test map fix on `url-conversion-v2` holds after the tracker.js change |

**Why R2 works:** after the full page load on the same origin, tracker.js re-boots and reads `sl_tracking` from that origin's `localStorage` — it never needs to touch `location.href` at all. We don't intercept the navigation; we simply don't need to.

---

## 2. CROSS-DOMAIN — this is where things break ❌

Context has to be *carried* in the URL, so it now depends on **how** the visitor leaves the page.

> **✅ UPDATE 2026-07-16 — cross-domain now WORKS from HTML mode.** Live-verified end to end on dev: a hosted page's link to `hunbalsiddiqui.com/thanks.html` fired the conversion and the dashboard count incremented. Two pieces landed on `url-conversion-v2`:
> 1. **Sender** — the inline snippet decorates outbound links / form actions / `window.open` with `sl_tid`/`sl_vid`/`sl_vh` (commit `912ed86`). Verified 13/13 on a dedicated harness.
> 2. **Receiver** — tracker.js Method 1 now fetches the variant's goals from `/api/resolve` instead of using `goals: []`, so the destination has patterns to match (commit `4022502`, non-blocking so the pageview never waits).
>
> **Both halves are required** — the sender alone attaches params that nothing reads.

| Navigation to a **different** domain | Result |
|---|---|
| Link click `<a href>` (HTML mode) | ✅ **CONFIRMED live (2026-07-16)** — conversion fired, dashboard count incremented |
| Form submit — **GET** (HTML mode) | ✅ **CONFIRMED live end-to-end 2026-07-16** — hidden inputs added during the submit event **are** serialized by the browser into the query string; survived a 307; destination entered Method 1 (`resolve` initiator `tracker.js:952` = `fetchGoalsLate`, which requires all three params); conversion fired and dashboard confirmed |
| Form submit — **POST** (HTML mode) | ⚠️ Decoration verified live (`action` rewritten); end-to-end not re-tested. Low risk — receiver is proven and can't tell how params reached its URL |
| `window.open(url)` (HTML mode) | ⚠️ Patch verified live (`__sl_patched === true`); end-to-end conversion not yet re-tested |
| Any of the above from **Redirect mode** | ❌ Still pending — the sender half for tracker.js (Phase 1B) is deliberately not ported yet |
| `window.location.href = otherdomain.com/...` | ❌ **Cannot be fixed automatically** — `location` is uninterceptable; needs manual `SplitLab.go(url)` (exists in `7b4fb22`, commented out) |
| `location.assign()` / `location.replace()` | ❌ Same as above |
| meta refresh / server-side redirect | ❌ Only survives if it forwards the query string |
| Destination has **no** tracker.js | ❌ Nothing reads the params |

---

## 3. PROXY mode (iframe)

The client's own site runs **inside** the iframe. tracker.js (mandatory in the client's source) runs inside that iframe and reads its own same-origin URL.

| Case | Result |
|---|---|
| Client's own multi-page site (Chrome) | ✅ **CONFIRMED live (2026-07-16)** — link click + `window.location.href` inside the iframe both fired the conversion (200, correct test/variant/goal) |
| Same, **Safari** | ✅ **CONFIRMED live (2026-07-16)** — conversion fired. ITP did **not** block the iframe's `localStorage`; no Storage Access API needed |
| Same, Firefox | ⚠️ Expected ✅ (stable partition, same mechanism as Chrome/Safari) — not explicitly tested |
| Iframe jumps to a **different** origin / pure third-party (Calendly) | ❌ Broken / impossible |

**Verdict:** proxy same-domain is **working**, not merely "should work" — the earlier ⚠️ was resolved by live testing on both engines. The partitioned iframe storage is stable because the top-level site (the custom domain) never changes during a proxy session, so tracker.js inside the iframe keeps its context across internal navigations.

---

## 4. `window.location.href` — the case everyone gets confused by

Your memory is correct, with one precision: **`window.location.href` is a problem only cross-domain.** Same-domain it works fine everywhere. Cross-domain it is the *one* navigation type we can **never** auto-fix (unlike links / forms / `window.open`, which the unmerged linker branch handles) — it always requires the client to call `SplitLab.go(url)` manually.

Inside proxy mode there are actually **two** `window.location.href` cases, and only one works:

- **Case A — same origin** (`clientsite.com/offer` → `clientsite.com/thanks`): ✅ Works (browser-dependent, Safari-fragile). The iframe navigates within its own origin, tracker.js reboots inside the iframe, reads its stable partitioned `localStorage`, fires the goal. No interception needed.
- **Case B — different origin** (`clientsite.com` → `calendly.com/thanks`): ❌ Broken. The iframe jumps to a new origin → new storage partition → no context. Proxy mode changes nothing here.

### `location.href` across all three modes

| Mode | same-domain `location.href` | cross-domain `location.href` |
|---|---|---|
| HTML | ✅ | ❌ (needs `SplitLab.go`) |
| Redirect | ✅ | ❌ (needs `SplitLab.go`) |
| Proxy (inside iframe) | ✅ browser-dependent | ❌ |

**Bottom line:** same-origin `location.href` works in every mode; cross-origin `location.href` works in none. Proxy mode's only new benefit is making the client's *own* multi-page site behave "same-domain-like" inside the iframe — it never fixes a jump to a genuinely different domain.

---

*See `url-conversion.md` for the full mechanism write-up, the chained-tests fix details, and the cross-domain linker edge-case checklist.*
