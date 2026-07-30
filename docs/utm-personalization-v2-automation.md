# UTM Personalization V2 — Automatic Audience/Angle Detection

## Background

V1 (see `docs/utm-personalization-v1.md`) requires an agency user to manually open the UTM Picker, create a rule (match on `utm_source`/`utm_campaign`/etc.), write the override text/image, and save it. This works, but the client's feedback is that most end users will never do this manually.

## What the client wants

Instead of a human manually building rules, the system should:

1. Detect which audience is visiting based on naming conventions in the ad platform (e.g. Facebook ad set name contains "Roofers").
2. Automatically generate personalized content (headline, image, etc.) for that audience using AI — without a human writing the copy.
3. Automatically create and serve the personalization rule going forward.

## How audience info reaches SplitLab

SplitLab cannot read ad account data directly (no access to ad set names inside Facebook/Google). It can only read whatever text is present in the URL. To get the ad set/campaign name into the URL, the client must configure **dynamic UTM parameters** on their ad platform (e.g. Facebook's `{{adset.name}}` macro), so a link like:

```
trysplitlab.com/page?utm_campaign=Summer_Push&utm_content=Roofing_Audience
```

is generated automatically per ad. If the client does not set this up, SplitLab only sees numeric IDs (`utm_content=120345678`), which carry no usable audience signal.

**Dependency:** this feature requires the client to correctly name ad sets/campaigns and enable dynamic UTM macros in their ad platform. This is a client-side setup requirement, not something SplitLab can control.

## Runtime flow — existing vs. new

**Existing (V1) flow — instant, client-side:**
1. Visitor loads the page with UTM params in the URL.
2. `serve/route.ts` fetches existing `personalization_rules` for the page and injects a small swap script into the HTML before it's sent to the browser.
3. On page load, the injected script reads the URL params and swaps matching text/image content immediately (no extra network round trip, no visible flicker).

**New (V2) flow — for a UTM value with no existing rule:**
1. System notices an incoming UTM value (e.g. `utm_content=Roofing_Audience`) that has no matching `personalization_rules` row.
2. Because calling AI synchronously during page load is too slow, this cannot happen on that same request. It has to run **in the background** (e.g. triggered async after detection).
3. AI generates suggested content (headline/image/etc.) for that audience.
4. Suggestion is either applied automatically or held for human approval (open question — see below).
5. Once a rule exists, all **subsequent** visits with that UTM value get the instant client-side swap, same as V1.

**Key point to communicate to client:** the *first* visitor from a brand-new audience will NOT see personalized content in real time — it takes at least one background AI cycle before a rule exists. Only visitors after that first detection get personalized content.

## Client answers (recorded 2026-07-29, verbal/voice-note)

The client responded to the first round of questions. Key points, in the client's own framing:

- **Not zero-input after all.** The end user (agency's client) *will* give input, but it's open-ended/lightweight setup, not manual per-visitor rule-building. They will tell SplitLab:
  - Which UTM field their setup uses to signal what they want detected (client said **`utm_campaign` or `utm_medium`** are the common ones — not necessarily `utm_content` as we'd assumed).
  - Optionally, a short free-text prompt/hint per value (e.g. "for roofer, this is what we're seeing on Facebook; for HVAC, this is what we're seeing"). This is optional — the user does not have to give a lot of detail if they don't want to.
- **Human approval — still undecided.** Client explicitly said "that's a good question" twice and did not commit either way, but leaned toward **wanting an approval option available**, not mandating fully-automatic from day one. Treat this as still open, not answered — our existing plan (build an approval gate first, allow auto-approve later per workspace) fits this.
- **Which fields AI can change — answered: start with the hero section only.**
  - V1 (first shipped version) scope: hero **headline, subheadline, hero text, hero image**.
  - Notably also **hero section layout/design** — client's team showed 5 different visual layouts of the same hero content, and wants that to be testable too, not just text/image swaps within one fixed layout.
  - Confirmed long-term direction: eventually the *whole page* will be personalizable, but hero-only is explicitly the starting scope.
- **Important reframe: this is not just "audience," it's "angle."** This changes our mental model:
  - The client does not only want to detect *who* is visiting (roofer vs. HVAC company). They also want to detect *why* / *what messaging angle* the ad was built around — e.g. an ad named with "Affordable" should shift copy toward affordability/cost messaging; an ad named with "Money Back Guarantee" should shift copy toward risk-free/guarantee messaging.
  - Client's own words: "it's not always audience... there could be more than that." Audience and angle are the two examples the client could think of, but the mechanism should be generic, not hardcoded to "audience."
  - **Design implication:** rules should not be modeled internally as "audience name." They should be modeled as a generic **keyword/value → messaging direction** mapping, where the "direction" could be an audience type, a pricing angle, a guarantee angle, or something else the client thinks of later — the *user defines what the value means* via their setup + optional prompt hint, and the system/AI doesn't need to know in advance whether it's audience or angle.

## Open questions for the client

Answered (see "Client answers" above) — kept here for traceability:

1. ~~Will the user provide zero input...~~ → **Answered: no, lightweight open-ended input is expected** (which field to key off, optional prompt hints).
3. ~~Which exact parts of the page should AI be allowed to change...~~ → **Answered: hero section first (headline, subheadline, hero text, hero image, and hero layout/design variations)**; whole page eventually.

Still open:

2. Should AI-generated content go live 100% automatically, or should a human approve it before it's used? (Client leaning toward wanting an approval *option*, not committed.)

Additional questions worth asking:

4. **Naming convention** — will the audience/angle keyword always appear as plain text in the campaign/adset name (e.g. "roofer", "Affordable"), or will there be codes/abbreviations (e.g. "RFG_23") that need a lookup/mapping table?
5. **Scale** — how many distinct audience/angle values should the system support at once per page (5? 10? unlimited)? This affects cost and the existing 20-rule-per-page cap (see gaps section below).
6. **Quality control** — even if approval isn't required up front, should there be periodic human review of AI-generated rules, or fully hands-off indefinitely?
7. **Brand voice / guardrails** — should AI be given tone/style rules (e.g. "always professional", "never use these words") to avoid off-brand output?
8. **Trigger threshold** — should a rule be created on the very first visit with a new UTM value, or only after some minimum number of visits (e.g. 10-20), to avoid generating rules from bot traffic or one-off/fake UTM values?
9. **Rollout scope** — should this run across all clients/pages immediately, or be piloted on one client/page first?
10. **Interaction with existing manual rules** — if a human has already manually created a rule for a given UTM value, does the automatic system leave it alone, or can it override/update it?
11. **Setup field, per workspace** — now partly answered (`utm_campaign` or `utm_medium` are the common ones), but need to confirm: is this field chosen once per workspace during setup (as part of the "tell us how you've set it up" onboarding step), or can a single workspace mix multiple fields for different rules (e.g. audience keyed off `utm_campaign`, angle keyed off `utm_medium`, at the same time)?
12. **Multiple simultaneous dimensions** — since audience and angle are both examples of the same underlying mechanism, can a single visitor match on *both* an audience rule and an angle rule at once (e.g. "roofer" + "affordable")? If so, how do the two sets of overrides combine on one hero section without conflicting (e.g. both trying to rewrite the same headline)?
13. **Layout/design variation generation** — the hero-layout-variation idea (5 different visual layouts of the same content) is a different kind of change than text/image swap-in-place (it's structural/HTML, not just content substitution via `field_selectors_json`). Does the client want AI to generate new layout structures automatically too, or will layout variations initially be a fixed set of pre-built templates that content gets slotted into?
14. **CTA destination URL** — personalization can currently only change the CTA's label text, not where it links. Is "personalize the CTA" expected to eventually include swapping the destination URL per audience/angle too (e.g. roofers → a roofer-specific landing page), or is label-only sufficient for now? Affects `HERO_FIELD_CONFIG`'s type system and `utm-swap-script.ts`, so worth deciding before it's built rather than after.

## Decisions made so far

- **Model:** use **Sonnet** (not Haiku) for auto-generated content, since this content may go live with little/no human review — quality matters more than speed/cost here. (Existing manual "AI Suggest" button in `suggest-headlines/route.ts:77` currently uses `claude-haiku-4-5-20251001`; V2's automatic path should use a Sonnet model instead.)
- **Rule scope:** confirmed via schema — `personalization_rules.page_id` and `test_variants.page_id` mean rules are **per page/variant**, not per workspace and not per whole test. Each variant of a test has its own page and must get its own independently-generated rule for the same audience (variants can have different base content, so the AI-personalized version will differ per variant too).
- **Detection field:** rather than matching on all 5 UTM params combined (combinatorial explosion, most combinations only ever seen once, cost blowup), detection should key off **one configurable "audience field"** per workspace (e.g. `utm_content`), ignoring the other UTM params for the purpose of "is this a new audience." Exact field (and whether exact-combination matching is also needed) is pending client answer (see open question 11).
- **Trigger mechanism:** scheduled background job (not on-request/synchronous detection). Reasons: keeps `serve/route.ts` fast path untouched, avoids duplicate-trigger races when multiple visitors with the same new UTM value arrive concurrently, and is simpler to reason about. Tradeoff already accepted: first visitor from a new audience never gets real-time personalization.
- **Bot/junk protection:** don't generate a rule off a single pageview. Require a minimum number of distinct visitors (not just pageviews — a bot can refresh one page many times) for a given UTM value, over a rolling window, before triggering AI. Suggested default: 5-10 distinct visitors, but should be a per-workspace tunable, not hardcoded (traffic volume varies a lot per client).
- **Approval step:** lean toward keeping a lightweight human-approval gate initially (dashboard "pending suggestions" list, Approve/Reject) even though the long-term goal is fully automatic — de-risks bad AI output going live unsupervised while trust is established. Can be relaxed to auto-approve per client/workspace later. Client has not committed either way yet, but is leaning the same direction.
- **Scope for V1 of this feature:** hero section only — headline, subheadline, hero text, hero image, and (stretch) hero layout/design variation. Not the whole page yet.
- **Rule model must be generic, not "audience-shaped":** internally, a rule should be a **keyword/value → override mapping**, where the meaning of that mapping (audience, pricing angle, guarantee angle, etc.) is defined by the user's setup + optional prompt hint, not hardcoded by SplitLab. This affects the DB/UX design — e.g. the setup step should ask "what UTM field, and what should each value mean to you," not "what audience segments do you have."
- **Setup is per-workspace, lightweight, user-provided:** each workspace tells SplitLab which UTM field they use (commonly `utm_campaign` or `utm_medium`) and, optionally, short free-text hints per value. This setup step doesn't exist yet and needs its own UI (separate from the existing manual UTM Picker).

## Finalized end-to-end flow (agreed after extended discussion)

1. **Traffic arrives.** Client's ad (Meta/Google, with dynamic UTM macros already configured on their end) sends a visitor to a specific variant's page with UTM params in the URL. Tracker already captures far more than the 5 standard `utm_*` params — also `hsa_*` (Google Ads auto-tagging), `ad_id`/`adset_id`/`campaign_id`/`creative_id`/`placement_id`, and click IDs (`gclid`, `fbclid`, etc. — see `tracker.js` `CLICK_ID_PARAMS`/`EXTRA_ID_PARAMS`). Click IDs are excluded from personalization detection since they're unique per click and never repeat.
2. **No rule exists yet** for this UTM combination on this variant — visitor sees default/normal hero content. Detection happens in the background, not on this request.
3. **Threshold gate.** System waits until a minimum number of *distinct visitors* (`visitor_hash`, not just raw pageviews — a bot/refresh can't game it) have shown up with this same combination, to avoid reacting to bot traffic or one-off fake UTM values. Default: **8 distinct visitors**, but this number must be a **per-workspace adjustable setting**, not hardcoded.
4. **Detection runs on a schedule, not in real time.** A background cron job scans `events.metadata` for UTM combinations crossing the threshold. Default interval: **every 45 minutes**, but this interval must also be an **adjustable setting** (not hardcoded), since it trades off freshness vs. database load.
5. **Glowing dot indicator.** Once threshold is crossed, the specific variant's "UTM Personalization" button/row in the dashboard gets a **glowing/pulsing dot** — a lightweight visual cue that something new was detected for that variant. No separate global notification/inbox system.
6. **User opens that variant's existing UTM Personalization screen** (the current `UTMPickerClient.tsx`), same place manual rules are managed. Inside, a card/modal surfaces: *"New UTM traffic detected — is this something you want to personalize for?"*
7. **Field selection (chip UI).** All detected params for that traffic are shown as selectable chips with their actual values (e.g. `utm_campaign: Roofing2024`, `utm_medium: cpc`, `hsa_grp: 18293`). One field is pre-selected by default (best-guess primary field, e.g. `utm_campaign`). User can accept the default with one click, or multi-select more fields to build an AND condition. This field choice is remembered per-page/variant going forward (sticky default, not asked again until user explicitly changes it via a "Change detection field" option on the same screen). Changing it later does not affect already-created rules — only future detections.
8. **User Accepts or Rejects.** Reject = dismiss, nothing saved (dot may reappear if traffic keeps arriving on future distinct combinations). Accept = proceeds.
9. **Rule shell created** — exact-match condition(s) from the selected field(s)/values, content still empty (draft state).
10. **AI content generation (Sonnet).** AI first reads the **variant's current live hero content** (`schema_json` — same pattern as the existing `suggest-headlines` route, which already does this and enforces per-field limits: headline <10 words, subhead <20 words, CTA 2-4 words). It then generates new hero content (headline, subheadline, hero text, hero image) tailored to the detected value, respecting the same field-level constraints, using **Sonnet** (not Haiku) with a hardened system prompt — since this content may go live with lighter review than the manual "AI Suggest" flow.
11. **Review/approval screen**, styled consistently with the existing UTM Picker (indigo brand color, dark-first, numbered step badges, split-screen live preview): shows (a) the rule's match condition in plain English, (b) which hero fields/elements will change, (c) the actual generated content live-previewed, (d) optionally a hero layout/design picker if layout variation is in scope.
12. **User approves (with optional inline edits) or rejects.** Approve writes the completed rule + content into `personalization_rules` via an insert-only path (see gap below — cannot reuse the existing full-replace POST endpoint).
13. **Rule now appears in the same list as manually-created rules** on that variant's UTM Personalization screen — no distinction in the UI between manually-authored and auto-detected-and-approved rules.
14. **All subsequent visitors** with that UTM combination get the existing instant client-side swap (V1 mechanism, unchanged) — no delay.
15. **Cycle repeats independently** for any other new UTM combination on that same variant, and independently again per variant (each variant/page has its own rule set and its own remembered detection field).

## UI/UX notes

- No dashboard-wide notification center — everything lives inside the existing per-variant UTM Personalization screen, consistent with where manual rules already live.
- Visual cue for "new detection available" = a **glowing/pulsing dot** on the variant's UTM Personalization button/row (not a static badge — must actively draw the eye, since there's no other notification mechanism prompting the user to check).
- Field-selection step = chip/button multi-select, values pre-filled from actual detected traffic (zero typing required).
- Content review step = reuse the existing split-screen layout pattern (left: editable AI-generated fields, right: live preview iframe) already used elsewhere in the AI page builder / UTM Picker.
- Detection-field choice is editable any time via a small "Change detection field" control on the same screen; changing it never retroactively affects already-created rules.

## Blocking gap found during todo verification (must be done first)

- **The `events` table has no UTM data at all, and pageview events send none.** Schema check of `events` (`supabase/migrations/001_initial_schema.sql:160-170`) shows only `test_id`, `variant_id`, `goal_id`, `visitor_hash`, `type`, `metadata jsonb` — no UTM columns. `tracker.js`'s `track("pageview")` call (line 1433) sends no UTM data; `metadata` today is only populated for conversion events (goal-trigger info), never for pageviews. The only place UTM values reach the server today is `form_leads`, and only for visitors who submit a form — the vast majority of visitors never do, so their UTM data currently never leaves `localStorage`.
- **Consequence:** the entire "distinct-visitor threshold per UTM combination" mechanism (flow step 3) has no data source to work from yet. This has to be fixed before any detection/threshold/background-job work can start.
- **Chosen fix:** send UTM data along with the pageview beacon and store it in the existing `metadata jsonb` column on `events` (no new column/migration needed) — same mechanism already used for conversion-event goal-trigger data, just extended to pageviews.

## Known conflicts / gaps found while verifying feasibility

- **No cron/scheduled-job infrastructure exists yet.** `vercel.json` has no `crons` config, and no existing cron route was found in `src/app/api`. The background-job trigger mechanism is new infrastructure, not a reuse of something existing.
- **The existing `personalization-rules` POST endpoint (`src/app/api/pages/[id]/personalization-rules/route.ts`) is full-replace, not additive.** It deletes *all* rules for a page and re-inserts whatever is in the request body. If V2's auto-write path called this same endpoint to add one new audience rule, it would silently delete every rule a human had manually created for that page. **V2 must use a separate, insert-only write path** (new endpoint or direct DB insert) that never touches existing rows — it cannot reuse the manual-save endpoint as-is.
- **Existing hard cap: `MAX_RULES = 20` per page.** If automation ends up detecting more than 20 distinct audiences for a single page, new auto-rules will hit this limit. Ties directly into open question 5 (scale) — if the client wants many audiences per page, we'll need either a higher cap or a policy for retiring low-traffic/stale auto-generated rules to make room.
- **Hero layout/design variation does not fit the existing swap mechanism.** Everything V1 built (`utm-swap-script.ts`, `field_selectors_json`, `overrides_json`) works by finding a CSS selector and replacing its `textContent`/`src` — it assumes the DOM structure stays fixed and only content inside it changes. Swapping the entire hero *layout* (structure, not just content) is a fundamentally different operation — closer to the existing AI page-rebuild/follow-up path (`src/app/api/pages/[id]/follow-up/route.ts`) than to the lightweight swap script. This needs its own design and is not just an extension of the current mechanism — flagged as open question 13.

## Relevant existing code (V1 building blocks this reuses)

- `src/lib/utm-swap-script.ts` — client-side match/swap logic (reused as-is).
- `src/app/api/serve/route.ts` (lines ~421-493) — injects the swap script at serve time (reused as-is).
- `personalization_rules` table (migrations 032/034) — where new AI-generated rules would be written (same schema, new write path).
- `src/app/api/pages/[id]/suggest-headlines/route.ts` — existing AI suggestion endpoint; pattern (reads `schema_json` hero content, per-field word-limit guidance) is reused for V2's auto-generation, but on Sonnet instead of Haiku.
- `field_selectors_json` on `pages` — defines which CSS selectors are editable fields; V2's "which parts of the page can AI change" question maps directly to which selectors are whitelisted here.
- `src/app/tracker.js/route.ts` (lines 170-197) — `LEGACY_PARAM_KEYS`, `CLICK_ID_PARAMS`, `EXTRA_ID_PARAMS`, `isTrackingParam()` — defines the full universe of trackable params; detection field-selection chips should be built from `utm_*` + `hsa_*` + `EXTRA_ID_PARAMS`, excluding `CLICK_ID_PARAMS`.
- `src/app/(dashboard)/clients/[id]/ai-pages/[pageId]/utm/UTMPickerClient.tsx` — existing per-variant UTM screen; V2's detection card/modal, chip selector, and review/approval UI all live inside this same screen, not a separate dashboard notification system.

## Hero auto-field-mapping design (discussed 2026-07-29, not yet built)

Follow-up to open question 13 / the "hero layout/design variation" gap — specifically, how the *field mapping* (which selectors AI is allowed to touch) should work for the auto-detection flow, as distinct from the existing manual "Map Elements" step.

**Core decision: separate storage, not shared/merged with manual mapping.**

- New page-level field: **`auto_field_selectors_json`**, same shape as the existing manual `field_selectors_json` (`Record<string, { selector: string; type: 'text' | 'image'; label: string }>`), but completely independent — its own column, its own read/write path.
- Fixed keys, dot-path convention matching what the AI page builder already bakes into generated HTML as `data-field="hero.*"` attributes (confirmed in `src/lib/ai-page-builder.ts:291-294`): `hero.headline`, `hero.subhead`, `hero.cta_text`, `hero.background_image`.
- **Do not merge/dedupe against manual `field_selectors_json`.** Earlier in this discussion a "merge by selector" idea was proposed and explicitly walked back — manual mapping keys are arbitrary slugified user labels (`labelToKey()` in `UTMPickerClient.tsx:76-78`, e.g. typing "Hero Title" → key `hero_title`), so there is no reliable way to match them against fixed `hero.*` keys. Keeping the two stores fully separate avoids this whole class of problem. If a manual field and an auto hero field happen to target the same DOM element, that's fine — two independent mappings, two independent rule types, no conflict.

**Detection has two very different difficulty tiers:**

- **AI-generated pages:** trivial. `data-field="hero.*"` markup already exists in the stored HTML at generation time — detection is just parsing existing attributes into selectors, no AI/LLM call needed for this step.
- **Raw/uploaded HTML pages:** genuinely harder. No `data-field` markup exists. The system has to do the AI-driven equivalent of what manual click-to-map already does for a human — identify which elements *are* the hero heading/paragraph/CTA/image, and if the target element has no `id`, inject a new unique id/attribute into the page's **stored HTML** (not just record a selector that assumes something exists). This is real, separate work from the AI-generated-page case and should be scoped/estimated as its own piece.

**Flow, per generate-preview click:**
```
user clicks "Generate preview"
  → check auto_field_selectors_json for this page
  → empty/missing? → detect hero elements (attribute-read if AI-generated, AI+selector-injection if raw HTML) → save
  → run existing content-generation call using those selectors
  → review stage (unchanged) → approve
```
On every later detection/rule for the same page, `auto_field_selectors_json` already exists, so it skips straight to generation.

**Edge cases identified:**

1. **Selector invalidation on HTML change — confirmed existing behavior to reuse.** Manual `field_selectors_json` is already cleared whenever the page's HTML is updated (manually or via AI edit) — confirmed by the user, this is current behavior, not something to build new. `auto_field_selectors_json` must be cleared the same way, via the same code path, so hero selectors never go stale/silently point at the wrong element after a redesign.
2. Raw-HTML detection must mutate and re-save the page's stored HTML (id injection) in the same atomic step as saving `auto_field_selectors_json` — a partial write (selectors saved but HTML not updated, or vice versa) leaves broken mappings.
3. Some pages have no hero section at all (non-landing-page layouts) — detection must return a clean "not found," not error or write empty/garbage selectors.
4. Ambiguous/unreliable detection on messy custom raw HTML — needs a "detection failed" path (error shown to user, fall back to manual mapping) rather than guessing and silently saving a wrong selector.
5. Partial hero (e.g. no background image, or no subhead) — `auto_field_selectors_json` and content generation must tolerate missing fields rather than requiring all four.
6. CTA today can only be `type: 'text'` — no way to represent changing the CTA's link/href, only its label. Flag as a scope decision if "personalize the CTA" is ever expected to include the destination URL.
7. Detection/generation failures must not leave `auto_field_selectors_json` half-written — compute fully in memory, write once, toast error on failure (same pattern as existing `generate()`/`reject()` handlers in `AutoDetectionPanel.tsx`).
8. Scope stays **HTML-mode only**, consistent with the existing `computeUtmSig` constraint — proxy/redirect-mode variants have no local page HTML to inspect, so hero auto-mapping doesn't apply to them at all.
9. Before writing the migration for `auto_field_selectors_json`, grep existing `supabase/migrations/` to confirm no earlier draft already used this or a similar column name.

Not yet built. No migration, no code, nothing committed/pushed — pure design, pending a decision on whether/when to implement.

## Todos

**Built (2026-07-29) — migration not yet run, nothing committed/pushed/deployed:**

- [x] ✅ Send UTM params (`utm_*` + `hsa_*` + `EXTRA_ID_PARAMS`, excluding click IDs) along with the pageview beacon in `tracker.js`, stored in `events.metadata` (`tracker.js`'s new `pageviewUtmMeta()`, plus `/api/event` computing a canonical `utm_sig`).
- [x] ✅ Migration `042_utm_auto_detection.sql`: `personalization_rules.source`/`is_draft`, relaxed `match_param` CHECK, `utm_detection_settings`, `utm_auto_detections`.
- [x] ✅ Background detection job (`/api/cron/utm-detect`, `vercel.json` cron entry every 15 min baseline, per-page `scan_interval_minutes`/`visitor_threshold` enforced in the handler, defaults 45 min / 8 visitors).
- [x] ✅ **Aggregation moved to a SQL function** (`utm_aggregate_pageviews` in the migration) instead of pulling raw event rows into Node and grouping in JS — event volume grows fast (every pageview, every client), so a JS-side reduce over a rolling window would not scale. Supporting indexes (`idx_events_variant_id`, a partial index on pageview rows with a `utm_sig`) added alongside it. The cron route now just calls `db.rpc('utm_aggregate_pageviews', ...)`.
- [x] ✅ Insert-only write path for auto-generated rules (`/api/pages/[id]/personalization-rules/auto` — POST for the rule shell/complete rule, PATCH to complete a draft) — does not touch the existing full-replace manual endpoint.
- [x] ✅ `/api/pages/[id]/personalization-rules/auto-generate` — Sonnet-based generation, reads current live field content first, respects existing per-field word-limit guidance, hardened system prompt for lighter-review content.
- [x] ✅ `/api/pages/[id]/utm-detections` — GET (list pending/notified) + PATCH (reject / update remembered detection field).
- [x] ✅ `DetectionDot` glowing/pulsing indicator, wired into the AI Pages list next to "UTM personalization".
- [x] ✅ `AutoDetectionPanel` (detection card + chip field-selector + hint input + AI content review/edit + Approve/Dismiss), mounted inside `UTMPickerClient`.
- [x] ✅ Verified with `tsc --noEmit` and `npm run build` — both clean.

**Still open:**

- [ ] Get remaining client answer: human approval mandatory vs. optional/auto-approve toggle (open question 2 — client leaning toward wanting the option, not committed). Current build always shows the review/edit screen before Approve — matches the "approval option" lean, but there's no auto-approve toggle yet.
- [ ] Get client answers on open questions 4-13 (naming convention, scale, QC, brand guardrails, threshold specifics, rollout scope, manual-rule interaction, multi-dimension audience+angle combination, layout-variation generation approach)
- [ ] Check whether a detected combination already has a matching manually-authored rule before surfacing it as 'notified' (noted as a known limitation in `/api/cron/utm-detect`) — currently it can show up for review even if a human already covered it; low-risk since Dismiss/Approve both resolve it either way, but wasteful.
- [ ] Per-page settings UI: nothing yet lets a user actually view/change `visitor_threshold`/`scan_interval_minutes` (DB columns exist with defaults, `detection_fields` is settable via the utm-detections PATCH endpoint, but there's no "Change detection field" control wired into the screen yet, nor a threshold/interval editor).
- [ ] Decide and design the hero-layout-variation mechanism separately — it doesn't fit the existing selector-based swap system (see gaps section); likely closer to the AI page-rebuild/follow-up path than to `utm-swap-script.ts`. Not started.
- [ ] Add cost/rate limits for automatic Sonnet calls (reuse pattern from `docs/ai-cost-limit.md`) — not implemented yet, the auto-generate endpoint has no rate limiting.
- [ ] Handle the existing `MAX_RULES = 20` per-page cap once scale answer comes back from client (the auto endpoint checks and rejects at the cap, but there's no retirement/replacement policy for low-value auto rules yet).
- [ ] Set `CRON_SECRET` env var before deploying, or the cron endpoint runs unauthenticated (it only checks the header when the env var is set, to allow local testing without it).
- [ ] Pilot on one client/page before rolling out broadly — no feature flag/gating exists yet; once deployed this runs for every page with qualifying traffic.
- [ ] Fix stale glowing-dot after dismiss/approve without a manual hard refresh: the dot is computed server-side (`utm_auto_detections` query in `tests/[testId]/page.tsx` and `ai-pages/page.tsx`) at page-load time, and Next's client-side router cache can serve a stale RSC payload on soft navigation/back — confirmed in local testing (dismissed a detection, `status` correctly flipped to `rejected` in the DB, but the dot kept showing until a hard refresh). Fix: add a focus/`visibilitychange`-based refetch (or periodic `router.refresh()`) so the dot self-updates without the user needing to know to hard-refresh.
- [ ] Proxy-mode and redirect-mode (302) variants are NOT covered by UTM auto-detection yet. `/api/serve`'s HTML-mode pageview insert now computes `utm_sig` server-side directly (fixed during local testing — the server-recorded pageview always wins `/api/event`'s per-visitor/test/day dedup race, so the client `tracker.js` beacon's UTM payload never actually lands), but the equivalent fix was only applied to the HTML-mode insert (`serve/route.ts` ~line 508-516). The proxy-mode insert (~line 336-346, `metadata: { redirect_url, proxy: true }`) and the plain-redirect insert (~line 386-393, `metadata: { redirect_url }`) still don't carry `utm_sig`, so auto-detection currently only works for HTML-mode tests. Needs the same `computeUtmSig(searchParams)` treatment applied to both before this feature can be considered complete for redirect/proxy variants.

**Hero auto-field-mapping (2026-07-29, follow-up session) — core detection + generation flow built (both tiers, atomic writes, explicit failure handling), UI polish + real-page testing still open, migration not run, nothing committed/pushed:**

- [x] ✅ Migration `043_auto_field_selectors.sql`: adds `pages.auto_field_selectors_json` (same shape as manual `field_selectors_json`, fully separate column). Confirmed via grep that no earlier migration used this or a similar column name.
- [x] ✅ Wired the same clear-on-live-HTML-replace treatment already applied to `field_selectors_json` onto `auto_field_selectors_json`, at all 4 existing call sites (mechanical, mirrors existing behavior exactly, does not change any current logic/condition):
  - `src/app/api/pages/[id]/route.ts` (~line 115, gated by existing `htmlReplaced`)
  - `src/app/api/pages/[id]/follow-up/route.ts` (~line 928, AI chat rewrite, non-variant live HTML)
  - `src/app/api/pages/[id]/schema-from-html/route.ts` (~line 493, raw HTML import, non-variant branch)
  - `src/app/api/pages/[id]/replace-variant/route.ts` (~line 49, variant draft → live promote)
  - **Dependency risk:** these `update()` calls now reference `auto_field_selectors_json` in the payload. Until migration 043 is actually run against a given DB, that column doesn't exist and these 4 update paths (manual edit, AI rebuild, raw HTML import, variant promote — all currently-working, frequently-used editing flows) will fail with an unknown-column DB error. **Migration must be run before testing/deploying this change**, consistent with the standing "don't run migration without explicit go-ahead" rule — flagging here so this isn't deployed ahead of the migration by mistake.
- [x] ✅ **Detection logic — AI-generated-page tier only** (`src/lib/hero-field-detection.ts`, `detectHeroFieldsFromHtml()`): regex-parses stored HTML for existing `data-field="hero.*"` attributes (headline/subhead/cta_text/background_image), infers `type: 'image'` for `<img>` tags and `'text'` otherwise, builds `[data-field="hero.X"]` attribute selectors (no id injection needed — `querySelector` in `utm-swap-script.ts` already supports attribute selectors directly). Returns `null` if no hero fields found (raw HTML, or no hero section) — treated as "nothing detected," not an error.
- [x] ✅ **Wired into `auto-generate/route.ts`**: checks `auto_field_selectors_json` first; if empty, fetches page HTML (`html_content` or storage fallback via `html_url`, same pattern as `preview/route.ts`) and runs detection; if hero fields are found, saves them to `auto_field_selectors_json` and uses them for content generation. (Superseded below — no longer falls back to manual `field_selectors_json`; see the "Manual-mapping fallback — removed" entry.) Verified with `tsc --noEmit` — clean.
- [x] ✅ **Raw/uploaded HTML tier — built** (`src/lib/hero-field-detection-raw.ts`, `detectAndInjectHeroFieldsRawHtml()`):
  - **Scope: fixed 4 fields only**, reading from the shared `HERO_FIELD_CONFIG`/`HERO_FIELD_KEYS` in `hero-field-detection.ts` (same config tier 1 uses) — adding a 5th field later is still a one-line change there, this tier's prompt and injection loop are already generic over that list, not hardcoded to 4.
  - Parses the page with `htmlparser2` (same library `inject-field-id/route.ts` already uses — not cheerio; cheerio's ESM build pulls in `undici`, which broke the webpack build with a private-class-field parse error), collects up to 120 candidate elements from tags likely to be hero content (`h1/h2/h3/p/span/div/a/button/img`) with their indexPath + a short text/src preview.
  - Sends the candidate list (not the raw HTML) to Sonnet, asking it to map each of the 4 field keys to a candidate's `indexPath` or `null` if not confidently identifiable — conservative by design, explicitly told never to guess and to return all-null if there's no identifiable hero section.
  - Injects `data-field="hero.X"` (not a new `id` — see collision-avoidance reasoning below) onto each identified element, then **hands off to tier 1's own `detectHeroFieldsFromHtml()`** to build the final selector map from the freshly-injected markup — no separate selector-building path, one parser for both tiers.
  - Returns `null` (clean "detection failed," not a thrown error) if zero candidates exist, the AI call throws, or no field was confidently identified — edge cases 3/4 from the design section.
  - **Collision-avoidance with manual mapping:** confirmed via `data-field`, not `id` — a DOM element can only carry one `id`, and the manual "Map Elements" flow (`inject-field-id/route.ts`) may have already injected one on the exact element the hero detector wants to tag. `data-field` is a separate attribute namespace, so there's never a collision regardless of whether manual mapping touched that element or not.
- [x] ✅ **Wired into `auto-generate/route.ts`**: tier 1 (attribute parse) runs first; if it finds nothing, tier 2 (AI raw-HTML detection) runs; if tier 2 succeeds, the mutated HTML + `auto_field_selectors_json` are written in **one atomic `update()` call** (plus a fresh storage upload via `uploadHtml()` if the page has a stored file, so `serve`/`preview` don't keep reading pre-injection HTML) — matching edge case 2's atomicity requirement. If the storage upload fails, the whole write is aborted rather than saving selectors that point at markup storage doesn't have yet. Only falls back to manual `field_selectors_json` if both tiers find nothing.
- [x] ✅ **Fixed a latent gap while wiring this in:** the "current live content" read for the content-generation prompt previously only checked `schema_json.hero`, which is empty for any raw-HTML or manually-mapped page (it's only ever populated for AI-generated pages' fixed hero.\* keys) — so raw-HTML/manual generation was silently working from blank "current content" context. New `src/lib/html-field-read.ts` (`readFieldValueFromHtml()`, htmlparser2-based, matches only the `#id` and `[data-field="..."]` selector forms this codebase actually generates) reads each field's real current value straight from the live HTML, falling back to `schema_json.hero` only if that fails.
- [x] ✅ Verified with `tsc --noEmit` and `npm run build` — both clean.
- [x] ✅ **"Generate preview" flow wiring — confirmed complete.** `auto-generate/route.ts` already does exactly the required sequence: check `auto_field_selectors_json` → detect (tier 1, then tier 2) if empty → compute fully in memory → write once atomically → run content generation using those selectors. No further change needed here; this was built in the same pass as the raw-HTML tier above.
- [x] ✅ **Manual-mapping fallback — removed, replaced with an explicit error (revised 2026-07-29).** Initially kept as a silent last-resort fallback when both detection tiers failed (edge cases 3/4), but reconsidered: silently reading from `field_selectors_json` — a deliberately independent, separately-owned store — inside the AUTO endpoint is confusing behavior a caller can't predict (sometimes auto, sometimes manual, no signal which). **Now:** if neither tier can identify a hero section, `auto-generate` returns an explicit `422` — `"Could not automatically detect this page's hero fields..."` — instead of quietly trying manual mapping. This is a clean behavior, not a regression: nothing in production today depends on this fallback (the whole hero-auto-mapping feature, migration included, has never shipped), so there's no working case being broken. A page whose hero genuinely can't be auto-detected still has the fully independent manual "Map Elements" + regular UTM rule flow available — just not silently invoked from behind this endpoint.
- [ ] **CTA destination URL — flagged as an open question for the client, not built.** Today `cta_text` is `type: 'text'` only — personalization can change the CTA's label but not its link/href. Building href support would mean adding a new field type across `utm-swap-script.ts` (the swap script only knows `text`/`image`), the manual `inject-field-id` flow, `HERO_FIELD_CONFIG`, and the review UI — real cross-cutting scope, not assumed here. Needs an explicit answer: is "personalize the CTA" expected to include where it links, or just its label? Folded into the existing open-questions list (was already edge case 6; now also added to the client-facing "Open questions" section above as question 14).
- [ ] Wire the "Generate preview" **UI** step (`AutoDetectionPanel.tsx`) to reflect that detection (including the AI raw-HTML call, which adds latency) may now happen transparently on first Generate click — currently no UI change was made, this todo only touched the API route; the panel doesn't yet show a "detecting hero fields..." loading state or a distinct message for "no hero section found, please map manually" (edge case 3/4) vs. other failures.
- [ ] Not yet tested against a real raw-HTML page locally — build/typecheck are clean but the actual AI identification accuracy (candidate selection, indexPath resolution, injection correctness) hasn't been verified end-to-end since the migration hasn't been run yet.
- [ ] Still blocked on client answers to open questions 4-13 (naming convention, scale, QC guardrails, threshold specifics, rollout scope, manual-rule interaction, multi-dimension combination, layout-variation approach) before this becomes a full build, not just plumbing.

## Todos (superseded/no longer applicable)

These were reasonable early on but are superseded by the finalized flow above — kept for history, not active work:

- ~~Ask client "which UTM field should identify audience" as an upfront onboarding step~~ → replaced by in-context, per-variant, first-detection field selection (chip UI), not a mandatory setup step.
- ~~Generate a new tracking link for the user to paste into their ad~~ → wrong direction; the client's existing Meta/Google ad already produces the link, SplitLab only ever reads incoming traffic, never issues links for ads.
- ~~Dashboard-wide "pending suggestions" notification list~~ → replaced by the glowing dot + in-screen card, scoped to each variant's existing UTM Personalization screen.
