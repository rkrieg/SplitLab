# URL Conversion — Failing Cases Only

Only the cases that **do not work** today, split by *why*. Same-domain works in every mode (see `url-conversion-cases.md`); everything below is cross-domain or proxy.

---

## A. The cross-domain linker — ✅ DONE (both modes, live-verified 2026-07-16)

> **⚠️ This section is now obsolete as a *failing* case.** It used to read *"failing ONLY because `conversion-url-fixes` isn't merged."* Both halves have landed on `url-conversion-v2` and both are live-verified. Framing it as one merge hid that there were always two halves:
>
> | Mode | Sender (attaches params) | Receiver (fires the conversion) |
> |---|---|---|
> | HTML | inline snippet (`c55de6f` → `912ed86`) ✅ | tracker.js (`4022502`) ✅ |
> | Redirect | tracker.js — **Phase 1B, 2026-07-16** ✅ | tracker.js (`4022502`) ✅ |
>
> **Nothing in the linker is outstanding.** Kept here only so the history isn't re-derived.
>
> **Scope limit:** the linker covers links, forms and `window.open` — the interceptable navigations. Cross-domain `window.location.href` stays ❌ in **every** mode; `location` cannot be hooked by any script. That's tracked as a cross-cutting item in `docs/url-conversion-v2-plan.md`, not here.

| Cross-domain case | HTML mode | Redirect mode |
|---|---|---|
| Link click `<a href>` (incl. new tab / middle-click) | ✅ **CONFIRMED live 2026-07-16** — conversion fired, dashboard incremented | ✅ **CONFIRMED live 2026-07-16** — 302'd `sl_vid` reappeared in the destination origin's `localStorage`; no other source possible |
| Form submit — **GET** (hidden inputs) | ✅ **CONFIRMED live end-to-end 2026-07-16** — browser serializes inputs added during the submit event; survived a 307; dashboard confirmed | ✅ **CONFIRMED live end-to-end 2026-07-16** — `?email=…&sl_tid=…&sl_vid=…&sl_vh=…`; dashboard confirmed |
| Form submit — **POST** (decorates `action`) | ⚠️ Decoration verified live; end-to-end not re-tested. Low risk — receiver proven, and it can't tell how params reached its URL | ⚠️ Not tested. Low risk, same reason |
| `window.open(url)` | ⚠️ Patch verified live (`__sl_patched === true`); end-to-end not re-tested. Low risk, same reason | ⚠️ Patch verified live (`__sl_patched === true`); end-to-end not re-tested |

**Hard requirement, unchanged:** the destination domain must have tracker.js installed to read the params. No reader, no conversion.

**Second hard requirement (redirect mode):** the redirect target must be a page SplitLab does **not** serve. `serve/route.ts:338` strips tracker.js tags from SplitLab-served pages and injects the inline snippet instead.

---

## B. Failing for reasons the branch does NOT fix ❌

Merging `conversion-url-fixes` does **not** rescue these — they fail for their own root cause.

| Failing case | Why it fails | Fix path |
|---|---|---|
| `window.location.href = otherdomain/...` (cross-domain) | The `location` object cannot be intercepted/patched by any script, so params can't be auto-added | Manual `SplitLab.go(url)` / `SplitLab.decorate(url)` — **code exists in `7b4fb22` but is commented out/disabled**; must be enabled + documented for clients |
| `location.assign()` / `location.replace()` (cross-domain) | Same root cause as above | Same — `SplitLab.go(url)` |
| `<meta http-equiv="refresh">` / server-side redirect on the destination | `sl_*` params survive only if the redirect forwards the query string, which most don't | No automatic fix |
| Destination domain has **no** tracker.js | Nothing on the destination reads the params | Install tracker.js there (mandatory) — no fallback |
| Third-party embedded widget (Calendly/Typeform iframe) reaching the goal | Conversion happens inside a cross-origin iframe, never surfaces as a URL on the destination | Not solvable via `url_reached` |
| **Proxy mode** — iframe jumps to a **different** origin, or pure third-party destination | New storage partition → no context; sealed cross-origin iframe | Reverse-proxy rewrite (heavy) — unsolved |

> Note on proxy mode, client's **own** same-origin pages: NOT in this list — ✅ **CONFIRMED live on Chrome AND Safari (2026-07-16)** via tracker.js inside the iframe. The predicted Safari-ITP risk did **not** materialise; ITP did not block the iframe's partitioned `localStorage`, and no Storage Access API / postMessage bridge was needed. (This note previously read *"browser-dependent, Safari-fragile, not yet live-tested"* — that's settled now.) See `url-conversion-cases.md` §3.

---

## Summary

*(Updated 2026-07-16.)*

- **Section A is closed.** The linker is complete on `url-conversion-v2` and **cross-domain works end-to-end in BOTH HTML and redirect mode**, live-verified (link + GET form, dashboard-confirmed in each). Sender and receiver both exist for every mode. **Cross-domain redirect was the last fixable ❌ in the matrix.**
- **Enable the commented-out `SplitLab.go(url)`** in `7b4fb22` (Phase 3) → fixes cross-domain `location.href` / `assign` / `replace`, but only if clients adopt it in their code.
- **Everything else in section B** (meta refresh, no-tracker destinations, third-party widgets, proxy cross-origin) has **no code fix available on any branch** today.
- **Proxy same-domain has moved out of the unknown column** — ✅ confirmed on Chrome *and* Safari (2026-07-16); ITP did not block the iframe's partitioned `localStorage`. See the note under section B.
