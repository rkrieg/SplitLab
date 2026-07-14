# Form-Lead Validation Fix — TODOs

## Context

**Bug (production, Titan Funding):** the tracker saved a form lead on the first click of a
submit button even when required fields (phone) were empty, then locked itself
(`_leadSent = true`), so the corrected second attempt was never saved. Result: partial lead
stored, complete lead (with phone) lost. Refreshing the page reset the lock, which is why a
third attempt after refresh worked.

**Fix:** before saving a lead, silently ask the browser whether every *visible* field passes
HTML constraint validation (`required`, `type=email`, `pattern`…) by reading
`el.validity.valid`. Invalid → skip the send WITHOUT locking, so the corrected re-submit
still captures. Fail-open everywhere: any uncertainty means send anyway (worst case = old
behavior, never lost data).

---

## ✅ DONE — HTML / hosted variants (`src/lib/tracking.ts`, hotfix shipped)

- ✅ Added `fieldsLookValid(scopeForm)` helper: reads `el.validity.valid` directly (no
  `invalid` events fired on the host page), checks visible fields only via
  `el.checkVisibility()` with an `offsetParent` fallback for old browsers
  (`position:fixed` popups treated as visible), fails open on any uncertainty.
- ✅ Gated `captureFormLead` (native form submit path): invalid form → skip send, leave
  `_leadSent` unlocked so the corrected re-submit fires.
- ✅ Gated `captureFormLeadFromAccumulated` (button-click / JS-submit fallback): scoped
  validity check via `_lastClickScopeForm` (the clicked button's form) so unrelated forms
  on the page (e.g. a footer newsletter with an empty required email) can never block a
  lead; invalid → skip without locking.
- ✅ Click handler records `_lastClickScopeForm` (`btn.form || btn.closest('form')`).
- ✅ Removed the `novalidate` exemption: Unbounce (Titan's builder) sets `novalidate` at
  runtime and validates with its own JS using the same `required`/`pattern` attributes —
  `validity.valid` is still computed per element regardless of `novalidate`, so the gate
  works on those pages too. (Confirmed on the real Titan page:
  `form.noValidate === true`, empty phone `validity.valid === false`.)
- ✅ Verified: `npm run build` passes; headless-Chrome tests of the real generated snippet
  — plain form AND runtime-`novalidate` (Unbounce-style) form: incomplete submit → 0
  `/api/form-leads` calls, corrected submit → exactly 1 complete lead (phone included),
  extra click → still 1 (dedup lock intact). Reproduced manually on the local Titan test
  page.

---

## ⬜ TODO — Redirect (302) and Proxy (iframe) modes (`src/app/tracker.js/route.ts`)

Both modes are served by the same script: redirect visitors land on the client's real site
with tracker.js installed; proxy mode iframes that same site, so the form still runs under
tracker.js. Nothing to change in the proxy wrapper page itself (it has no form and cannot
see into the iframe).

- [ ] Port `fieldsLookValid(scopeForm)` helper into tracker.js (same rules: `validity.valid`
  property reads only, visible-fields-only via `checkVisibility()` + `offsetParent`
  fallback, fail-open, NO `novalidate` exemption).
- [ ] Gate `captureFormLead` (global `submit` listener path): invalid form → skip send
  without locking.
- [ ] Fix `_leadSent` ordering in the submit handler: today it sets `_leadSent = true`
  BEFORE calling `captureFormLead(form)` (to stop the fetch/XHR patch double-sending) —
  change so the lock is only set when a lead was actually sent (e.g. `captureFormLead`
  returns a boolean), otherwise a blocked invalid attempt burns the lock.
- [ ] Gate `captureFormLeadFromAccumulated` (submit-word click fallback + fetch/XHR network
  patch paths) with the scoped check: record `_lastClickScopeForm` in the global click
  handler; fields inside unrelated `<form>`s must never block.
- [ ] Verify like the HTML fix: `npm run build`; headless test — incomplete submit → no
  `/api/form-leads` call and no lock, corrected submit → single complete lead, repeat click
  → no duplicate. Test both a plain `required` form and a runtime-`novalidate` form.
- [ ] Rollout note: tracker.js is served with `Cache-Control: max-age=300`, so the fix is
  live on all client sites within ~5 minutes of deploy; single-commit change for instant
  `git revert`.
