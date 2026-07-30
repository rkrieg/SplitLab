# UTM Personalization V2 — Session Handoff (2026-07-29)

For continuing in a new session. Full design lives in `docs/utm-personalization-v2-automation.md` — read that first; this is just the "where we left off."

## Standing constraints (still in force, never rescinded)

- **Do NOT commit.** **Do NOT push.** **Do NOT run the migration** (`042_utm_auto_detection.sql`). User tests locally against their dev DB and applies/reverts SQL manually themselves.

## What's built and locally verified (core V1→V2 detection loop)

End-to-end flow confirmed working in local testing for **HTML-mode tests only**:
traffic → UTM capture (`serve/route.ts` computes `utm_sig` server-side) → cron detection (`/api/cron/utm-detect`) → `notified` status → glowing dot (both `ai-pages` list and test detail page) → detection card in `AutoDetectionPanel` (inside `UTMPickerClient.tsx`) → field-selection chips → AI content generation (Sonnet) → review/edit → Approve (creates rule) or Dismiss (permanent — a rejected detection can never auto-resurface) with a confirm modal.

All of this is typechecked clean (`tsc --noEmit`) and built clean (`npm run build`). Nothing committed.

## Explicitly out of scope right now

- **Proxy-mode and redirect-mode (302) variants** — `computeUtmSig` fix only applied to the HTML-mode pageview insert in `serve/route.ts`. Proxy/redirect inserts still don't carry `utm_sig`. User's explicit instruction: focus on HTML mode only for now.
- **Hero layout/design variation** (structural redesign, not just content swap) — doesn't fit the existing selector-based swap mechanism at all; would need something closer to the AI page-rebuild/follow-up path. Not designed yet, just flagged (open question 13).

## Known open bug (diagnosed, not fixed)

Stale glowing dot after dismiss/approve: dot is computed server-side at page-load; Next's client-side router cache serves a stale RSC payload on soft nav, so the dot only clears on a hard refresh. Proposed fix (not yet implemented, awaiting go-ahead): focus/`visibilitychange`-based refetch or periodic `router.refresh()`.

## Where we are now: hero auto-field-mapping design (pure design, nothing built)

This session's discussion (last ~10 messages) worked out the design for how the **new hero-only auto-detection flow** should map fields, as distinct from the existing manual "Map Elements" step. Full writeup is in the doc's new **"Hero auto-field-mapping design"** section, just above Todos. Summary of the decisions:

1. **New, separate storage**: `auto_field_selectors_json` on `pages` — same shape as manual `field_selectors_json`, but its own column, never merged/deduped with the manual one (manual keys are arbitrary slugified user labels, so there's no reliable way to match them against fixed keys anyway).
2. **Fixed keys**, matching the dot-path convention already baked into AI-generated pages as `data-field="hero.*"` attributes: `hero.headline`, `hero.subhead`, `hero.cta_text`, `hero.background_image`. (Earlier proposal of underscore keys like `hero_heading` was wrong and was corrected mid-session — verified against `ai-page-builder.ts:291-294`.)
3. **Two difficulty tiers for detection**: AI-generated pages already have the `data-field="hero.*"` markup, so detection there is just reading existing attributes (no AI call needed). Raw/uploaded HTML has none of that — detection has to do the AI-driven equivalent of manual click-to-map (identify the element, inject an id/attribute into the *stored* HTML if none exists). This is real, separate, harder work — flagged explicitly, not yet scoped/estimated.
4. **Flow**: on "Generate preview" click → check `auto_field_selectors_json` → if empty, detect (attribute-read or AI+injection) → save → continue into existing content-generation call → review → approve, same as today.
5. **9 edge cases logged in the doc**, most notably: selector invalidation — confirmed by the user that manual `field_selectors_json` is *already* cleared whenever page HTML is updated (manually or via AI edit), so `auto_field_selectors_json` must be cleared via that same existing code path, not a new mechanism.

**Nothing has been implemented for this yet** — no migration, no column, no detection code. This is 100% design captured in the doc, pending a decision on when/whether to start building it.

## Natural next steps (not yet decided/started)

- Find the existing code path that clears `field_selectors_json` on HTML update (grep for it) — confirm exactly where to hook the same clear for `auto_field_selectors_json`.
- Scope/estimate the raw-HTML id-injection detection piece specifically — it's the hard, unbuilt half of this design.
- Decide whether to build the AI-generated-page path first (much easier, no injection needed) as a smaller first slice.
- Still waiting on client answers to open questions 4-13 in the main doc (naming convention, scale, QC, brand guardrails, threshold specifics, etc.) before this becomes a full build.
