# URL Conversion — Failing Cases Only

Only the cases that **do not work** today, split by *why*. Same-domain works in every mode (see `url-conversion-cases.md`); everything below is cross-domain or proxy.

---

## A. Failing ONLY because `conversion-url-fixes` isn't merged 🔧

These fail on the current branch purely because the cross-domain linker code lives on the unmerged **`conversion-url-fixes`** branch. **Merging it fixes them.**

| Failing case (cross-domain) | Fixed by | Commit |
|---|---|---|
| Link click `<a href>` → other domain (incl. new tab / middle-click) | Auto-decorates the URL with `sl_tid`/`sl_vid`/`sl_vh` | `7b4fb22` (redirect / tracker.js) · `c55de6f` (HTML / snippet) |
| Form submit to another domain (POST decorates `action`; GET adds hidden inputs) | Same linker | `7b4fb22` · `c55de6f` |
| `window.open(url)` → other domain | `window.open` monkey-patched to decorate first | `7b4fb22` · `c55de6f` |

**Requirement even after merge:** the destination domain must have tracker.js installed to read the params.

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

> Note on proxy mode, client's **own** same-origin pages: NOT in this list — those should work via tracker.js inside the iframe (browser-dependent, Safari-fragile, not yet live-tested). See `url-conversion-cases.md` §3.

---

## Summary

- **Merge `conversion-url-fixes`** → fixes all of section **A** (cross-domain links, forms, `window.open`).
- **Enable the commented-out `SplitLab.go(url)`** in `7b4fb22` → fixes cross-domain `location.href` / `assign` / `replace`, but only if clients adopt it in their code.
- **Everything else in section B** (meta refresh, no-tracker destinations, third-party widgets, proxy cross-origin) has **no code fix available on any branch** today.
