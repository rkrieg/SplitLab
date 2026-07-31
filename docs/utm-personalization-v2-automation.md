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

## PIVOT (2026-07-30) — client feedback after seeing the V2 build

Client (voice note + follow-up chat) reacted to the built approve-gated, value-chip flow above. Two core complaints:

1. **"You're gonna show every combination and permutation of the UTM variables... there's gonna be a million different ones."** The chip UI (flow step 7) shows actual detected *values*. At real traffic volume this list is unusable. Fix: show **field names only** (a small fixed dropdown: Campaign, Medium, Source, etc.), never raw detected values.
2. **"This isn't really the feature... this is just using AI to help you manually do it."** The approval/review-before-live step (flow steps 6, 8, 11, 12) is exactly what the client doesn't want. The vision is AI recognizing and personalizing **without a human in the loop at all** — no chip picker, no review screen, no Approve button.

### Confirmed via follow-up Q&A (2026-07-30)

- **Scale:** "dozens... could be a ton" of audiences/angles concurrently per page. The hard `MAX_RULES = 20` cap must be raised/redesigned — 20 is far too low.
- **Fully autonomous confirmed:** "Yes, this is supposed to be autonomous." No approval step, no review screen. AI content goes straight live.
- **Rule setup, client's own words:** a dropdown where the user picks UTM field(s) (can combine, e.g. Campaign + Medium = AND condition), then gives a **loose plain-English hint** per rule — not exact values. Example: "in Campaign look for something like 'United States', and in Medium look for something like 'audience' — if both are there, make the page more applicable." The user does NOT type exact match values; hints can be as loose as "just make this more applicable."
- Client acknowledges giving users fine-grained parameter control is *possible* but "complicates it a little" — prefers the simpler loose-hint model.

### New flow (replaces "Finalized end-to-end flow" above)

1. **User defines a rule upfront, before any matching traffic exists.** Dropdown to pick UTM field(s) (AND combination), plus an optional free-text hint per rule (can be left blank). No raw detected values are ever shown — this replaces the old "wait for traffic, then show chips" model entirely.
2. **No approval step exists anywhere in this flow.** Rule creation is the only human action; everything after that is autonomous.
3. **New visitor arrives** with some value in the watched field(s) (e.g. `utm_campaign=Texas_Roofers_2024`).
4. **Is this exact value-combination already resolved?** (cached from a prior AI judgment for this same rule) → yes: instant swap via existing V1 mechanism, no AI call, no delay. → no: continue.
5. **Background job judges the new value-combination against the rule's hint using AI** ("does `Texas_Roofers_2024` match the hint 'roofers'?" — or, if no hint was given, AI decides purely on the raw value whether it's worth personalizing at all). This must run in the background (same reasoning as before — AI calls are too slow for the request path), evaluated once per new value-combination, then cached.
6. **Match confirmed →** AI generates hero content (reuses existing `auto-generate` content-generation logic, hero-field detection tiers 1/2 unchanged) → **written straight to `personalization_rules` as a live, non-draft, exact-match rule** for this specific value-combination — no draft/review/approve state.
7. **No match →** nothing happens, value is cached as "no match" so it's never re-judged.
8. **All future visitors** with that exact value-combination get the instant V1 client-side swap, same as before.
9. **Repeat independently** per rule, per page/variant.

### What this removes from the built V2 flow

- The **value-chip picker** in `AutoDetectionPanel` (`detection.utm` entries as selectable chips) — replaced by a field-name-only dropdown at rule-*creation* time, not traffic-*reaction* time.
- The **cron's distinct-visitor-threshold "detect new combo, then notify" trigger** (flow steps 3-6 in the old design) — rules are now user-defined upfront; the background job's job changes from "discover new audiences from traffic" to "judge whether an already-anticipated rule's hint matches a new incoming value."
- The **glowing dot + review/approval card** (`DetectionDot`, the Accept/Reject + review/edit stage in `AutoDetectionPanel`) — content goes live with no human checkpoint.
- **Exact-match-only condition model** as the sole matching mode — a new AI-judged "does this value match this hint" mode is added alongside it (exact match still used for the *cached* re-visit case, step 4 above).
- Hard `MAX_RULES = 20` — needs raising or a retirement policy, given "dozens... could be a ton."

### What's reused as-is

- UTM capture into `events.metadata`, `utm_sig` computation (`tracker.js`, `/api/event`).
- Hero-field auto-detection, both tiers (`src/lib/hero-field-detection.ts`, `src/lib/hero-field-detection-raw.ts`) — still needed to know which selectors AI-generated content should be written into, regardless of matching model.
- Content-generation logic in `auto-generate/route.ts` (Sonnet call, per-field guidance, reads current live content) — reused, just triggered from the background matcher instead of a user clicking "Generate preview" after Accept.
- Insert-only write path (`personalization-rules/auto/route.ts`) — reused, but the `is_draft`/approval-gated PATCH-to-complete flow is no longer needed since nothing stays in draft state.
- V1 client-side swap mechanism (`utm-swap-script.ts`) — unchanged, still how repeat visitors get instant personalization once a value-combination is resolved.

### Client answers, round 2 (2026-07-30, chat)

Client confirmed the full pivot flow as described above ("everything else seems correct") and added:

- **Content scope — answered.** Hero section only **for now**; confirmed long-term direction is AI rebuilding the *entire* page per audience eventually, but that's explicitly out of scope for this build. No change needed to the current hero-swap approach.
- **Rule cap / rate limiting — not given a number.** Client's answer was "we're going to have to play with this to make it feel right" — i.e. expects to tune it empirically after seeing it run, not a fixed spec up front. Practical implication: ship with a conservative default (current placeholder `MAX_RULES_PER_PAGE = 200`) and make it easy to adjust later, rather than blocking on an exact number. Still no daily AI-call budget/cost cap — that specific risk wasn't addressed by this answer and should stay flagged.

### Scope expansion — hero section revamp, not just field swap (2026-07-30, later same day)

Client's "this isn't really the feature" complaint (see top of PIVOT) also applies to *content* scope, not just process: swapping individual field strings in place is still fairly manual-feeling. Decision made this session:

- **AI should be able to revamp the whole hero section** — content AND layout/CTA together, as one block — not just substitute text into fixed selectors one field at a time.
- **New DB column:** `personalization_rules.hero_html` (nullable text) — stores a full replacement HTML block for the hero section. Coexists with the existing `overrides_json` (per-field swap); a rule uses one or the other. Migration `045_hero_revamp.sql`, **not yet written/run**.
- **Detection dependency:** a full-section swap needs a reliable selector for the hero *container*, not just its individual fields. AI-generated pages have this for free — `ai-page-builder.ts` always emits the hero as `<section class="hero">...</section>` (confirmed via grep), so the container selector can just be `section.hero`. Raw/uploaded HTML pages have no such reliable marker.
- **Decision: ship AI-generated pages only, for now.** Raw HTML pages keep the existing field-swap behavior (`overrides_json`) rather than blocking the whole feature on raw-HTML hero-container detection, which is real, separate work (parallel to the existing tier-1/tier-2 split in hero-field-detection). **This is a deliberate, explicit gap — not a silent one — and must stay tracked as a todo, not forgotten once AI-generated pages work.**
- **Swap mechanism:** `utm-swap-script.ts` needs a new branch — if the active matched rule has `hero_html`, replace the hero container's `outerHTML` wholesale; otherwise fall back to the existing per-field `textContent`/`src` swap loop (unchanged) for `overrides_json`-only rules (this is how existing manual + old auto rules keep working unmodified).
- **Generation change:** the AI prompt in `auto-personalize.ts` needs a new mode — instead of "give me new strings for these 4 field keys," it needs "rewrite this entire `<section class="hero">...</section>` block," given the current hero HTML as context, encouraged to vary layout/structure, not just copy.

### Visibility decision — reuse the existing simulator, don't build a new preview (2026-07-30)

Discussed and rejected `dangerouslySetInnerHTML`-rendering a raw hero HTML snippet directly in the rules list: the generated HTML depends on the page's own CSS (Tailwind/page `<style>` block), which isn't loaded in the dashboard shell — a bare snippet would render unstyled/broken, not a useful preview.

**Better, already-built option:** `UTMPickerClient.tsx` already has a UTM-simulator dropdown (`utmSimulator` state) that points the existing full-page preview iframe at a rule's query string, rendering the real page with real CSS and the swap applied. Since `initialRules` is an unfiltered `select('*')` from `personalization_rules`, **auto-created rules already land in this same dropdown for free** — no new preview code needed, as long as they still produce a valid `ruleQueryString()` (they do, since `conditions_json` is populated the same way regardless of source).

Remaining gap: the rule *edit panel* below the dropdown (`renderRuleFields`) currently assumes per-field text inputs (`overrides_json`) — it has no representation for a rule whose content lives in `hero_html` instead. Needs its own editable form (e.g. a raw-HTML textarea, or field-level inputs re-derived from the hero HTML) — not yet designed.

### Bug found this session — duplicate-rule validation dropped during extraction

The original `personalization-rules/auto/route.ts` POST endpoint has always deduped by exact condition signature across **all** existing rules for a page (manual and auto both, no `source` filter) before inserting — rejecting a second rule with identical conditions. When `insertLiveAutoRule()` was extracted into `src/lib/auto-personalize.ts` for the cron job, **this dedupe check was not carried over** — it's missing today. Net effect: the cron could currently create a duplicate rule with the exact same conditions as an existing manual (or auto) rule, and `utm-swap-script.ts`'s tie-break logic (most-specific-conditions wins; ties fall to array order) would pick between them non-deterministically from the user's point of view.

**Decision:** restore the same exact-signature check inside `insertLiveAutoRule()` — scoped across manual + auto rules together, same as the original endpoint. If a rule with that exact condition signature already exists, skip creating a new one and cache the match (`utm_auto_rule_matches`) as resolved, linking `personalization_rule_id` to the **existing** rule instead of a new one. Manual rules always win by default; auto never overwrites or duplicates.

### Still open / blocking further scoping

- **Cost/rate limiting** — client expects to tune the *rule cap* by feel, but did not address the separate risk of unbounded AI-call cost per day if traffic is messy/high-volume. Worth a basic daily cap as a safety net even before the "right" number is known.
- **Per-version stats** — since each matched rule creates its own personalized version under one variant, does the client want performance tracked separately per version, or combined into the variant total?
- **Raw-HTML hero revamp** — explicitly deferred (see scope expansion above), not answered by the client, needs its own detection design (hero-container identification) before it can be built.

## Todos (current — reflects the pivot + scope expansion, as of 2026-07-30)

**Built and working (pivoted implementation, pre-scope-expansion):**

- [x] ✅ UTM capture into `events.metadata` (`utm_sig` computed server-side in `/api/event` and `serve/route.ts`) — unchanged from before the pivot, still the data source everything else reads from.
- [x] ✅ Hero-field auto-detection, both tiers (`src/lib/hero-field-detection.ts`, `src/lib/hero-field-detection-raw.ts`) — unchanged, reused as-is by the new flow.
- [x] ✅ Migration `044_utm_auto_rules.sql` (**not yet run**): `utm_auto_rules` (user-defined rule templates: page_id, fields[], hint) and `utm_auto_rule_matches` (per-rule AI-judgment cache keyed by projected value-combination signature). — **superseded by PIVOT 3, see below.**
- [x] ✅ `src/lib/auto-personalize.ts`: `judgeUtmHintMatch()` (AI yes/no judgment against a rule's hint), `generateHeroOverrides()` (content generation, extracted from the old auto-generate route, logic unchanged), `insertLiveAutoRule()` (writes a completed, non-draft rule directly, no approval state). — **judge/generation signatures superseded by PIVOT 3, see below.**
- [x] ✅ `src/app/api/pages/[id]/auto-rules/route.ts` — GET/POST/DELETE for rule templates. — **validation superseded by PIVOT 3, see below.**
- [x] ✅ Rewrote `src/app/api/cron/utm-detect/route.ts` — no more visitor-threshold traffic discovery; now projects traffic onto each active rule's watched fields, judges new value-combinations via AI (once per combination, cached), and on match generates content + writes a live rule directly. — **row-projection logic superseded by PIVOT 3, see below.**
- [x] ✅ `src/components/utm/AutoRulesPanel.tsx` — field-name dropdown (no raw values), optional hint textarea, rule list with delete. Replaces and deletes the old `AutoDetectionPanel.tsx`. Wired into `UTMPickerClient.tsx`. — **UI superseded by PIVOT 3, see below.**
- [x] ✅ Verified with `tsc --noEmit` and `npm run build` — both clean.
- [x] ✅ Client confirmed (2026-07-30): everything in the pivoted flow correct; content scope originally confirmed hero-only (superseded same day by the hero-revamp scope expansion below).

**PIVOT 3 (2026-07-31) — per-field row model, replaces single shared hint (see "PIVOT 3" section above):**

- [x] ✅ `044_utm_auto_rules.sql` reverted back to its originally-applied `fields`/`hint` form (had already been run locally — editing it in place was wrong). New migration `046_utm_auto_rules_rows.sql` (`alter table`, adds `rows jsonb not null default '[]'`, drops `fields`/`hint`) — **not yet run**.
- [x] ✅ Updated `src/app/api/pages/[id]/auto-rules/route.ts` POST validation to accept/validate `rows[]` (field allow-list, `look_for` min length, `instructions` only kept when `personalize: true`, `MAX_ROWS_PER_RULE = 5`).
- [x] ✅ Rewrote `src/components/utm/AutoRulesPanel.tsx` as a per-row table (field dropdown, look-for input, personalize checkbox, conditional instructions textarea, "+ Add More", up to `MAX_ROWS_PER_RULE`).
- [x] ✅ `src/lib/auto-personalize.ts`: added `filterRowsMatch()` (literal case-insensitive contains-match for `personalize: false` rows, no AI call), `judgeUtmRowsMatch()` (AI judge over only `personalize: true` rows' category hints, includes gender/age naming-convention guidance), `mergePersonalizeHint()` (combines all personalize rows into one generation hint). Old `judgeUtmHintMatch()` removed.
- [x] ✅ `src/app/api/cron/utm-detect/route.ts`: derives `fields` per rule from deduped `rows.map(r => r.field)`; resolves filter rows via `filterRowsMatch()` before any AI call (cached as no-match on failure, no AI cost); calls `judgeUtmRowsMatch()`/generation only when `personalize: true` rows exist and filters passed; pure-filter rules (no personalize rows) are cached as matched but never generate content (nothing to personalize).
- [x] ✅ Verified with `tsc --noEmit` and `npm run build` — both clean.
- [ ] Manual QA: recreate the 4 example rows discussed on the call (source filter, campaign→location, campaign→audience, content→messaging angle) against a test page once migration `044` is run on dev; verify combined personalization output. **Blocked on running the migration — needs explicit go-ahead per standing rule.**

**NOT yet built — this session's scope expansion (hero revamp), needed before today's dev ship:**

- [ ] **Write migration `045_hero_revamp.sql`** — adds `personalization_rules.hero_html` (nullable text). Do not run yet, per standing rule — write it, confirm with the user, then run alongside 044 when ready to test on dev.
- [ ] **Add hero-container detection for AI-generated pages** — a function (likely in `hero-field-detection.ts`, alongside the existing tier-1 field parser) that returns the `section.hero` container's outer HTML given the page's stored HTML. Raw-HTML pages return null/unsupported for now (explicit gap, tracked below).
- [ ] **Add a hero-revamp generation function** in `auto-personalize.ts` (alongside `generateHeroOverrides`) — prompts Sonnet to rewrite the entire hero container's HTML (content + layout + CTA) given current hero HTML as context, returns the new HTML block instead of a field-keyed JSON object.
- [ ] **Update the cron** (`utm-detect/route.ts`) to call the hero-revamp function instead of (or as a preferred alternative to) `generateHeroOverrides`, and pass the result into `insertLiveAutoRule()` as `hero_html` (with `overrides_json: {}`).
- [ ] **Update `insertLiveAutoRule()`** to accept and store an optional `heroHtml` param.
- [ ] **Restore the duplicate-signature check** inside `insertLiveAutoRule()` (see "Bug found this session" above) — this must ship alongside the hero-revamp work, not after, since scope expansion increases how often the cron writes new rules.
- [ ] **Extend `utm-swap-script.ts`** with a new branch: if the active rule has `hero_html`, replace the hero container's `outerHTML`; otherwise keep the existing per-field swap loop unchanged.
- [ ] **Add `hero_html` to the 3 serve-time `personalization_rules` selects** (`serve/route.ts`, `preview/route.ts`, `pages/[slug]/route.ts`) so it reaches `buildUtmSwapScript()` — currently they only select `match_param,match_value,is_fallback,overrides_json,conditions_json`.
- [ ] **Add an "Auto" badge** in `UTMPickerClient.tsx`'s rules list for rows where `source === 'auto'`.
- [ ] **Design an editable representation for `hero_html` rules** in the rule edit panel (`renderRuleFields` currently assumes per-field text inputs from `overrides_json` only) — likely a raw-HTML textarea for a first pass.
- [ ] **Confirm the existing UTM-simulator dropdown surfaces auto-created rules correctly** (should be free, per the visibility decision above) — verify, don't assume.
- [ ] **Explicitly flag as a known gap, not silently skipped:** raw/uploaded HTML pages do not get hero revamp yet — they keep the old field-swap-only behavior. Needs its own follow-up design (hero-container detection for raw HTML, parallel to the existing tier-2 field detection).

**Still open — everything else (deprioritized for today's ship, per user instruction):**

- [ ] **Cost/rate limiting** — no daily AI-call budget exists. Client didn't set an exact rule cap either ("we're going to have to play with this to make it feel right") — ship with the current placeholder (`MAX_RULES_PER_PAGE = 200`) and make it easy to tune, but a basic daily cost cap is still worth adding as a safety net regardless of that number.
- [ ] **Per-version stats** — each matched rule creates its own personalized version under one variant; not yet decided whether the client wants stats tracked separately per version or combined into the variant total.
- [ ] **Bot/junk protection** — the new design judges on first sighting of a value-combination, no minimum-visitor threshold like the old design had (8 visitors). Not explicitly re-confirmed with the client whether this is acceptable risk. **Confirmed concretely as a scalability problem in the 2026-07-31 session notes above** (1000 visitors with 1000 distinct combinations → up to 1000 AI generations, and the existing `MAX_RULES_PER_PAGE` cap doesn't stop the AI spend, only the DB insert) — no longer purely theoretical, should be prioritized alongside the cost/rate-limiting todo below.
- [ ] **CTA destination URL** — still label-only; personalizing the CTA's link/href is a separate, cross-cutting scope decision not yet answered by the client.
- [ ] **Proxy-mode and redirect-mode (302) variants** are still not covered — auto-personalization only works for HTML-mode tests (the `utm_sig` fix was only applied to the HTML-mode pageview insert in `serve/route.ts`).
- [ ] Set `CRON_SECRET` env var before deploying, or the cron endpoint runs unauthenticated.
- [ ] Pilot on one client/page before rolling out broadly — no feature flag/gating exists yet.
- [ ] Run migrations `044_utm_auto_rules.sql` and `045_hero_revamp.sql` before any end-to-end testing (needs explicit go-ahead, per the standing rule — user has agreed to running these specifically on dev to unblock testing).
- [ ] Not yet tested against a real live visitor/page — everything above has only been verified by `tsc`/`build`, never an actual served page with matching UTM traffic. Given the pivot's history (a swap-script wiring bug was previously invisible to both `tsc` and `build` and only surfaced in live testing), treat all of the above as unverified until tested the same way.

**Carried over, unaffected by the pivot (from the hero-auto-field-mapping work, 2026-07-29):**

- [x] ✅ Migration `043_auto_field_selectors.sql` (adds `pages.auto_field_selectors_json`) and its 4 clear-on-live-HTML-replace call sites — still needs to be run before deploying, alongside migrations 044 and 045.
- [x] ✅ Tier 1 (attribute parse) + Tier 2 (AI raw-HTML detection + injection) hero-field detection, atomic writes, explicit `422` failure instead of a silent manual-mapping fallback.
- [x] ✅ Swap-script wiring bug (auto selectors never read at 3 serve-time call sites) — found and fixed during manual testing; merged into `serve/route.ts`, `preview/route.ts`, `pages/[slug]/route.ts`.
- [ ] Not yet tested against a real raw-HTML page locally.
- [ ] No dedicated loading state distinguishing "detecting hero fields" from ordinary content generation — cosmetic.

## PIVOT 3 (2026-07-31) — per-field row model replaces single shared hint

Client call (voice, transcribed) reacting to the built `AutoRulesPanel` (field multiselect chips + one shared free-text hint per rule). Complaint, in his own words: a single hint can't express "for THIS field look for THIS kind of thing, and personalize THIS way" per field — he wants the same visual layout as the existing manual rule table (`When utm_source = facebook AND utm_campaign = Roofers_2024 AND ...`) reused for Auto, but with the "value" cell repurposed as a loose AI category instead of a literal string, and independent personalize controls per row.

### Confirmed model

A rule is an **ordered list of rows**, not a field-set + one hint. Each row:

- `field` — same dropdown as the manual rule table (`utm_source`, `utm_campaign`, `utm_medium`, `utm_content`, `utm_term`, `ad_id`, `adset_id`, `campaign_id`, `creative_id`, `placement_id`, `hsa_*`).
- `look_for` — text. Meaning depends on `personalize`:
  - `personalize: false` → **literal filter value**, matched case-insensitively as a substring (not exact-equality) against the incoming UTM value — e.g. `look_for: "facebook"` matches `utm_source=Facebook_Ads`. No AI call for these rows; see "Edge case" below for why contains-match was chosen over exact-equality.
  - `personalize: true` → **loose category description** for AI to judge against the actual incoming value (e.g. "location", "audience", "messaging angle") — never a literal value; the AI extracts whatever concrete signal is present.
- `personalize` — boolean. `false` rows are pure match/filter conditions (client's `utm_source = facebook` example — "no personalization necessary, it just only applies to that rule"). `true` rows drive content generation.
- `instructions` — optional text, only meaningful when `personalize: true` — how to use the detected value (e.g. "urgency angle → hero copy emphasizes a deadline").

The same `field` can appear in multiple rows with different `look_for`/`personalize` targets (client's own example: `utm_campaign` once for "location", again for "audience"). Rows are AND'd — all filter rows must match, and (if any exist) personalize rows must be judged as matching, for the rule to fire.

**Worked example (client's own, from the call):** rule = `[{field: utm_source, look_for: "facebook", personalize: false}, {field: utm_campaign, look_for: "location", personalize: true, instructions: "put the detected city/country in the hero heading"}, {field: utm_campaign, look_for: "audience/profession", personalize: true, instructions: "tailor headline to the detected profession"}, {field: utm_content, look_for: "messaging angle", personalize: true, instructions: "urgency → deadline-driven copy; affordable → price/discount emphasis"}]`. Incoming traffic `utm_source=facebook&utm_campaign=denver_dentist&utm_content=flash_sale_urgent` → filter row passes (facebook), personalize rows resolve to Denver + Dentist + Urgency → AI merges all three into one hero rewrite ("Denver Dentists — Grow Your Practice, Offer Ends Tonight!").

### Edge case resolved this call — filter-row matching semantics

Raised during this session: `utm_source` in the wild isn't always a clean literal (`facebook` vs `fb` vs `Facebook_Ads` vs `meta`) — strict `===` would silently miss traffic a human would obviously call "Facebook." **Decision: case-insensitive substring (`contains`) match for `personalize: false` rows**, not AI-judged and not strict equality. Cheap (no AI call on the highest-volume/most-repetitive part of a rule), deterministic, and forgiving of naming variants, at the cost of being coarser than true fuzzy matching — accepted tradeoff; can be upgraded to AI-judged per-row later if it proves too loose/strict in practice.

### Age/gender detection — flagged, not solved

Client, on the call: "we might have to instruct the AI to look for... male, female, that sort of stuff" when personalizing by age/gender signals in ad naming. Treated as a prompt-engineering note for the personalize-row AI judge/generation prompts (recognize common gender/age abbreviations in campaign/adset names), not a new UI control or schema field.

### What this replaces

- `utm_auto_rules.fields text[]` + `utm_auto_rules.hint text` (single shared hint per rule) → `utm_auto_rules.rows jsonb` (array of `{field, look_for, personalize, instructions?}`).
- `AutoRulesPanel.tsx`'s field-multiselect-chips + one shared hint textarea UI → a table layout matching the existing manual-rule screenshot (`When [field ▾] [look_for text] [personalize ☐] [instructions] AND ...` + Add More), with per-row controls.
- `judgeUtmHintMatch(fields, hint, utm)`'s single-hint prompt → judges only the `personalize: true` rows' categories (filter rows are resolved by literal contains-match before any AI call, not passed to the judge at all).
- `generateHeroOverrides`/`generateHeroRevamp`'s single `hint` param → a merged instruction string built from all `personalize: true` rows' `look_for` + `instructions`, combined into one content-generation prompt (multiple personalize rows on one rule combine into one hero rewrite, not one call per row).

**Update (same day):** migration `044_utm_auto_rules.sql` had already been run locally by the time this was implemented (user confirmed), so the original plan (edit 044 in place) was wrong — `044` was reverted back to its originally-applied `fields`/`hint` form, and the column swap ships as a new migration, `046_utm_auto_rules_rows.sql` (`alter table` adding `rows jsonb`, dropping `fields`/`hint`). `045_hero_revamp.sql` already occupied the next number.

### UX follow-ups after the row model shipped (2026-07-31, same day)

- **"Just filter" (personalize=false) rows only matter combined with a personalize row.** Clarified during review: a filter row alone is a scoping condition ("only run this rule for Facebook traffic"), never a content change by itself — the AI/hero-rewrite path only runs when the rule has at least one `personalize: true` row. A rule made entirely of filter rows would previously get cached as "matched" by the cron but silently generate nothing — a confusing no-op the user would have no way to notice.
  - **Fix:** both `AutoRulesPanel.tsx`'s `saveRule()` and `auto-rules/route.ts`'s POST validation now reject saving a rule with zero `personalize: true` rows ("Add at least one 'Personalize with AI' row — a rule made only of filter rows never changes anything.").
  - Filter rows remain fully supported and encouraged *alongside* personalize rows in the same rule — that combination (e.g. filter by `utm_source=facebook`, personalize on `utm_campaign`→location) is exactly the client's own worked example from the pivot call.
- **Per-row UX redesign** (`AutoRulesPanel.tsx`): replaced the single checkbox + relabeled input with a two-button segmented "Mode" toggle ("Just filter" vs. "Personalize with AI") shown *before* the value input, so the input's meaning is set upfront instead of silently changing based on an easy-to-miss checkbox. Added a one-line helper caption under the input explaining exactly how matching/detection works in plain language, and gave the optional instructions textarea its own label.
- **Field-relevant placeholders, not generic examples.** Every field in `FIELD_OPTIONS` now has its own `{filter, category, instructions}` example set in `FIELD_EXAMPLES`, so e.g. `utm_medium` shows "cpc/paid_social" and a "search vs. social" instructions example, not an unrelated Facebook/urgency example copied from a different field. The 5 opaque ID fields (`ad_id`, `adset_id`, etc.) honestly flag their category mode as "rarely useful — opaque numbers with no readable meaning to detect" rather than faking a plausible-looking example.
- **One field per rule, enforced client- and server-side.** The field dropdown disables/greys out any field already used by another row in the same rule (labeled "(in use)"), "+ Add More" auto-picks the next unused field, and `auto-rules/route.ts` also rejects duplicate fields within one rule's `rows[]` server-side.
- **Filter-only rules blocked at save time.** A rule made entirely of `personalize: false` rows can never generate content (the cron only calls the AI judge/generation path when `personalize: true` rows exist) — it was previously a silent no-op. Both `AutoRulesPanel.tsx`'s `saveRule()` and `auto-rules/route.ts`'s POST now reject saving a rule with zero personalize rows.

### Bug found this session — duplicate-rule race condition (2026-07-31)

Found via manual testing: two identical live `personalization_rules` rows appeared for the exact same condition combination (`utm_source=facebook AND utm_campaign=denver_leads AND utm_content=urgent_flash_sale AND utm_medium=email`), both auto-created.

**Root cause:** `insertLiveAutoRule()`'s duplicate check (see the earlier "Bug found this session — duplicate-rule validation dropped during extraction" entry above) was a **select-then-insert**, i.e. an application-level check-then-act, not a database-level guarantee. It's race-free *within* a single cron run (the cron processes rules in a sequential `for` loop, no concurrency), but **not** race-free *across* concurrent cron invocations — e.g. the cron endpoint manually curled twice in close succession while testing (exactly what happened this session). Two overlapping invocations can both read "no existing rule for this signature" before either write commits, so both insert — producing the duplicate observed.

**Fix — moved the guarantee to the database (migration `047_personalization_rules_dedupe.sql`):**
- New column `personalization_rules.condition_signature` (text) — the same normalized (sorted, lowercased) signature string `insertLiveAutoRule()` already computed in memory, now persisted.
- Backfilled for existing rows (both the current `conditions_json` array shape and the legacy single `match_param`/`match_value` shape).
- Pre-existing exact-duplicate rows deleted (kept the oldest of each duplicate set) — required before the constraint below could be added.
- **`create unique index on personalization_rules (page_id, condition_signature)`** — enforced atomically by Postgres. Fallback rows always have `condition_signature = null`, and Postgres treats every `NULL` as distinct for uniqueness purposes, so the one-fallback-per-page rule (existing separate constraint) is unaffected.
- `insertLiveAutoRule()` (`src/lib/auto-personalize.ts`) rewritten to insert optimistically and only fall back to looking up the existing row if Postgres rejects the insert with a `23505` (unique_violation) error — the database decides who wins a race, not app-level timing.
- `normalizedConditionSignature()` exported from `auto-personalize.ts` and reused in the manual rules endpoint (`src/app/api/pages/[id]/personalization-rules/route.ts`) so manually-created rules also populate `condition_signature` — keeps the constraint meaningful across manual + auto rules together, matching the original (pre-race-fix) app-level check's scope.
- **Known residual gap, not fixed by this migration:** concurrent cron invocations can still both run the AI judge/generation calls for the same new combination before either insert resolves — the DB constraint prevents the duplicate *row*, but not the duplicate *AI spend*. Only one row survives, but you may pay for two judge/generation calls. Not addressed here (would need an advisory lock or similar around the cron's per-page/per-signature processing) — flagged as a follow-up, not blocking.

Migration `047_personalization_rules_dedupe.sql` — **not yet run.**

## Session notes (2026-07-31, later same day) — hero-container detection hardening, Auto Rules UI reflow, and a scalability gap confirmed

### Hero-container detection now prefers the `SL:hero` marker over a raw class regex

`detectHeroContainerFromHtml()` (`src/lib/hero-field-detection.ts`) previously matched the hero section purely via `<section class="hero">...</section>` regex. Turns out there's a stronger existing signal it wasn't using: `ai-page-builder.ts`'s system prompt already requires every top-level block to be wrapped in a permanent `<!-- SL:name --> ... <!-- /SL:name -->` comment marker (`ai-page-builder.ts:378-397`), named after the block's first CSS class — so the hero section is always `<!-- SL:hero -->...<!-- /SL:hero -->` when the LLM complies.

**Fix:** `detectHeroContainerFromHtml()` now tries the `SL:hero` marker first (returns the trimmed inner content) and only falls back to the old `class="hero"` regex for pages generated before this convention or on the rare chance the LLM dropped the marker but kept the class. This is a real improvement — the marker's comment boundaries can't be confused by a nested `</section>` inside the hero block, which the old non-greedy class regex was vulnerable to — but **it is explicitly not 100% reliable**, since it still depends on LLM prompt compliance rather than code-enforced structure. Confirmed with the user this tradeoff is understood, not assumed.

Follow-up hardening: the `follow-up/route.ts` "style" edit path (full-page rewrites, 4+ sections changed) only had a generic "MUST include markers" instruction with no explicit warning against dropping markers on *untouched* sections. Added an explicit line telling the LLM never to drop/rename/omit an existing marker — even on sections it didn't intend to change — because downstream automation (hero personalization) depends on it (`follow-up/route.ts:58`). Note the "patch" edit path (1-3 sections) was already safe by construction — markers are stripped before sending to the LLM and re-added by code (`follow-up/route.ts:162-170`), so only the "style" path needed the extra instruction.

### `AutoRulesPanel.tsx` reflowed into a modal, checkbox replaces the mode dropdown

Client saw the shipped `AutoRulesPanel` UI and asked for changes matching a new voice note:
- The rule editor was an inline card squeezed into the sidebar — client wants it in a modal (like the existing manual-rule "New UTM Rule" modal) for more room, styled the same way (title/description/Cancel+Save footer).
- Column layout requested explicitly: **UTM field | Looking for | Personalize (checkbox) | ✕** — a literal checkbox for "do you want to personalize this field," not the previous `contains` / `personalize:` `<select>` dropdown. Unchecked = pure filter row (client's own example: Facebook-only traffic, "no personalization necessary, it just only applies to that rule"). Checked = reveals an optional "instructions" input below that row.
- Client explicitly confirmed the instructions field stays optional — "you shouldn't have to tell it anything... it should be able to determine by the text."

Implemented: `AutoRulesPanel.tsx`'s row editor now opens in a `Modal` component (reusing the same `Modal` used for manual rules), with a `grid` column-header layout and a real `<input type="checkbox">` per row instead of the old select. Modal size started at `lg`, user found it too wide, reduced to `md` (max-w-lg) to match the manual-rule modal's width. Verified clean with `tsc --noEmit` after each change.

### Confirmed via Q&A: matching/caching behavior works as designed for repeat vs. new UTM combinations

Walked through two example URLs differing only in `utm_campaign`/`utm_content` values against the same page. Confirmed against the actual cron/serve code (not just the design doc): a **repeat** visit with an already-resolved exact value-combination gets the instant V1 client-side swap with no cron/AI involvement (matches `personalization_rules` directly at serve time). A **new** value-combination is invisible to the visitor on first hit — `utm_sig` isn't in the cron's `alreadyJudged` cache (`utm-detect/route.ts:122-124`) yet, so nothing happens until the next cron run judges it.

### Scalability gap confirmed, not yet fixed — AI spend and rule volume both scale with distinct UTM combinations, with no real ceiling

User raised: if e.g. 1000 visitors arrive with 1000 different UTM value-combinations in one cron window, does that mean up to 1000 hero variants get generated? Verified against the code — **yes, and it's worse than just rule count:**

1. **`MAX_RULES_PER_PAGE` (200, `auto-personalize.ts:25`) only blocks the DB insert, not the AI spend.** In `insertLiveAutoRule()` (`auto-personalize.ts:358-370`), the judge call and the content-generation call have both already happened by the time the cap check runs — the cap just discards the result. Once a page is capped, every further new combination still pays for a full Sonnet judge + generate call for nothing.
2. **There is no threshold on how "worth judging" a new combination is before the cron spends AI on it.** Every new `utm_sig` — even one seen from a single visitor — triggers a judge call. This is the same gap already flagged under "Bot/junk protection" in the Still-Open todos below: the original pre-pivot design had an 8-distinct-visitor minimum before triggering AI (to filter out bot traffic and one-off/noise UTM values), and it was dropped entirely when the flow moved to user-defined-rules-plus-autonomous-matching. It was never re-confirmed with the client as an acceptable removal, and this session's math (1000 visitors → up to 1000 hero generations) is a concrete illustration of why it matters, not just a theoretical risk.

**Recommended fix (discussed, not yet implemented):**
- Reintroduce a minimum-distinct-visitor threshold (e.g. 5-8 distinct `visitor_hash`, not raw pageviews) per new `utm_sig` before the cron will judge it at all — this is the real fix for the 1000-visitor scenario, since it stops one-off/rare combinations from ever reaching the AI, not just from being stored.
- Move the `MAX_RULES_PER_PAGE` check to run *before* the judge/generate calls, not after, so a capped page stops spending immediately instead of generating-then-discarding.
- A per-cron-run batch cap on how many new combinations get processed in one invocation, as a blunt backstop independent of the above.

Not yet implemented — pending explicit go-ahead, consistent with this thread's "deprioritized for today" bucket below. This should be considered a load-bearing addition to the existing "Bot/junk protection" and "Cost/rate limiting" todos, not a separate concern.

## Todos (superseded/no longer applicable)

- ~~Ask client "which UTM field should identify audience" as an upfront onboarding step~~ → replaced by upfront rule creation (field dropdown + optional hint) via `AutoRulesPanel`.
- ~~Generate a new tracking link for the user to paste into their ad~~ → wrong direction; the client's existing Meta/Google ad already produces the link, SplitLab only ever reads incoming traffic, never issues links for ads.
- ~~Dashboard-wide "pending suggestions" notification list~~ → superseded twice: first by the glowing dot + in-screen card, then by full autonomy (no notification needed since nothing needs a human decision).
- ~~Value-chip picker showing every detected UTM combination~~ → replaced by a field-name-only dropdown at rule-creation time (client: "there's gonna be a million different ones").
- ~~Approval/review-before-live step, `DetectionDot`, `AutoDetectionPanel`~~ → removed entirely; client confirmed fully autonomous, no human checkpoint.
- ~~Cron's distinct-visitor-threshold "detect new combo, notify" trigger~~ → replaced by AI-judged hint matching against user-defined rule templates.
- ~~Hard `MAX_RULES = 20` cap~~ → raised to a placeholder `200`, pending the client's empirical tuning.

## Session notes (2026-07-31, later still) — cron performance R&D: server impact, parallelism, timeout risk

User asked whether the cron (unique-link volume, potentially many AI calls) could impact server speed, and whether the AI calls run in parallel. Verified directly against `src/app/api/cron/utm-detect/route.ts`, `vercel.json`, and `src/lib/auto-personalize.ts` rather than assuming:

1. **No impact on visitor-facing serving speed.** The cron is its own Vercel serverless function (`vercel.json:14-19`, path `/api/cron/utm-detect`), completely separate from the function(s) that serve actual visitor traffic (`serve/route.ts`). Cron load never competes with or blocks requests from real visitors hitting a live test page.

2. **AI calls are NOT parallel today — fully sequential, one at a time.** The route is two nested `for` loops (over each page's active rules, then over each rule's unresolved value-combinations), with `await judgeUtmRowsMatch(...)` then `await generateHeroRevamp()`/`generateHeroOverrides()` awaited one at a time — no `Promise.all` or batching anywhere in the file. A run with N unresolved combinations makes N judge calls and (for matches) N generate calls back-to-back, not concurrently. This directly bounds throughput per invocation and is the real lever behind the earlier "1000 visitors → 1000 generations" concern — it's not just cost, it's wall-clock time within one run.

3. **Real risk found: no `maxDuration` set on the route, so the cron can silently time out mid-run under high combination volume.** Vercel serverless functions have a max execution duration governed by plan/config; this route doesn't export `maxDuration` or set anything in `vercel.json`'s (nonexistent) `functions` block to extend it. Since processing is sequential and each Sonnet call can take multiple seconds, a run with many new combinations can get cut off by the platform's function timeout partway through — remaining combinations in that run simply don't get processed, with no error surfaced (they just get picked up, or not, on the next run).

4. **Doc/schedule drift found:** `vercel.json:17` actually schedules the cron at `*/5 * * * *` (every 5 minutes), not the "every 45 minutes" default described earlier in this doc ("Finalized end-to-end flow," step 4) — that description is stale and should be treated as superseded by the real config. The 5-minute cadence partially mitigates risk #3 (unprocessed combinations get retried sooner), but does not fix it — if new combinations arrive faster than one run can sequentially process them, the backlog never clears.

**Net takeaway:** this reinforces, rather than replaces, the earlier scalability recommendation (distinct-visitor threshold before judging + capping AI spend before insert) — that fix reduces AI-call *volume*, which is the actual root cause of both the cost risk and this timeout risk. A `maxDuration` bump and/or a per-run batch cap (mentioned above) would be a direct, complementary mitigation for the timeout specifically. None of this has been implemented yet — R&D/documentation only, per this thread.

## Session notes (2026-07-31, later still) — raw-HTML hero-container detection, implemented

Follow-up to the earlier confirmation that the raw-HTML field-swap path (Tier 2 in `hero-field-detection-raw.ts`) is only ever triggered from the cron (`generateHeroOverrides()`), never from any wired-up UI button — the old `personalization-rules/auto-generate/route.ts` endpoint that duplicates this logic is dead code, not called from anywhere in the dashboard. From the user's point of view the flow is unaffected by this (rule creation + cron matching works identically); the actual gap was that raw/uploaded HTML pages had no equivalent of the `SL:hero` marker, so `generateHeroRevamp()` (the *full hero-section* rewrite mode) always returned null for them and silently fell back to the older field-by-field swap — meaning raw HTML pages never got the richer hero-revamp experience AI-generated pages get.

### Todos agreed, then implemented this session

- [x] ✅ **`hero-field-detection-raw.ts` — container detection added.** `detectAndInjectHeroFieldsRawHtml()` now also computes the nearest common DOM ancestor of the identified hero field elements (`findHeroContainer()`), with edge-case guards: requires at least 2 identified fields (`MIN_FIELDS_FOR_CONTAINER`) before even attempting it; rejects the ancestor if it's `<html>`/`<body>` (too broad); rejects it if it also wraps a `<nav>`/`<footer>`/`<header>` (walked up too far, past the real hero into a page-wide wrapper); rejects it if it has more than `MAX_CONTAINER_DESCENDANT_TAGS` (80) descendant tags (sanity bound against accidentally capturing most of the page). Returns `containerFound: boolean` alongside the existing `updatedHtml`/`selectors` so callers can tell field detection and container detection apart — a page can succeed at one without the other.
- [x] ✅ **Marker injection reuses the existing hardened `SL:hero` convention, not a new regex.** Rather than inventing a third detection branch, the container gets wrapped with literal `<!-- SL:hero -->` / `<!-- /SL:hero -->` comment nodes spliced into the DOM before serialization — so the already-existing `detectHeroContainerFromHtml()` (its first, marker-based branch) picks it up for free on the next call, no `hero-field-detection.ts` changes needed for server-side extraction. The container element is also separately tagged `data-hero-container="1"` (a real attribute, not a comment) specifically for the client-side swap script, which can't query HTML comments.
- [x] ✅ **`auto-personalize.ts`'s `generateHeroRevamp()` restructured** to try raw-container detection when the marker/class regex finds nothing: calls the updated `detectAndInjectHeroFieldsRawHtml()`, and on success persists the mutated HTML (`html_content` + re-uploads `html_url` if present) and `auto_field_selectors_json` in one atomic `pages` update — same pattern Tier 2 field-detection already used — then re-runs `detectHeroContainerFromHtml()` against the freshly-saved HTML so the extraction logic stays single-sourced. Detection only ever runs once per page: the marker gets persisted into the HTML itself, so every subsequent cron match on that page hits the fast regex path directly, no repeat AI call.
- [x] ✅ **`utm-swap-script.ts` runtime selector fixed (the critical missing piece found during verification).** The client-side swap previously hardcoded `document.querySelector('section.hero')` to find the element to replace at runtime — confirmed this would have made raw-HTML hero-revamp rules generate successfully in the DB but never actually visually apply for any real visitor, since raw pages have no `class="hero"` element. Now falls back to `document.querySelector('[data-hero-container]')` when `section.hero` isn't found.
- [x] ✅ **Silent-failure logging added** at both raw-detection call sites (`generateHeroRevamp()` and `generateHeroOverrides()`) — previously bare `catch { x = null }` with no `console.error`, matching the same invisible-failure pattern already flagged elsewhere in this doc (`insertLiveAutoRule()`'s pre-047 duplicate check). Now every failure path (AI call throws, HTML upload fails, DB save fails) logs which page and which stage failed.
- [ ] **Not yet tested against a real raw/uploaded HTML page.** Verified with `tsc --noEmit` only (clean) — same caveat as everything else in this feature: the pivot's history includes at least one bug (the original swap-script wiring gap) that was invisible to `tsc`/`build` and only surfaced in live testing. Treat this container-detection code as unverified until run against a real page with real traffic.
- [ ] **Known accepted risk, not fixed this session:** concurrent cron invocations on the same raw-HTML page could both attempt container detection/injection simultaneously (same class of race as the pre-047 duplicate-rule bug, but on an HTML column, not a row — no unique-constraint equivalent applies). Last write wins; small risk, not blocking, consistent with how the equivalent Tier 2 field-detection race was already left unaddressed.

## Session notes (2026-07-31, live debugging) — container-first redesign implemented; found two real bugs live-testing against a messy Unbounce export

Implemented the container-first redesign from the section below (`detectHeroContainerRawHtml()`, `detectHeroFieldsWithinContainer()`, shared `ensureRawHeroContainer()` in `auto-personalize.ts`, `querySelectorAll` fix in `utm-swap-script.ts`) — all code changes, `tsc --noEmit`/`npm run build` clean, confirmed non-breaking for AI-generated pages (marker/attribute checks short-circuit before any raw-HTML code path runs).

Live end-to-end test (real cron run, real UTM traffic) against a Titan Funding real-estate lending page (Unbounce export, same messy-page-builder class as `titan.html`): the container-first redesign worked — single AI call for container detection (`detectHeroContainerRawHtml -> container found and marked`, no more duplicate/non-deterministic calls), successful hero-revamp generation, live rule created. But the user reported the personalized content wasn't visually appearing on the page despite this. Debugged with a headless-Chrome harness (`puppeteer-core` + the already-installed system `google-chrome` binary — no new dependency added) since curl can't execute the client-side swap script. Found two real, distinct bugs:

**Bug A (fixed): swap script self-retrigger loop, 15-20+ redundant `outerHTML` replacements per page load.** The hero-revamp generation prompt requires the AI's output root to be `<section class="hero">...</section>` (a fixed instruction, written for AI-generated pages where that's always literally true). On raw HTML pages, this means the *replacement* content itself now contains a real `<section class="hero">` wrapper — so after the first swap, `utm-swap-script.ts`'s `document.querySelector('section.hero')` starts matching **our own injected output**, not the original page. Every `MutationObserver` tick (itself triggered by our own DOM write) re-finds and re-replaces this same element, in a loop that only stops when the observer disconnects after 10 seconds. Content was correct each time (idempotent), but wasteful and caused visible layout-thrashing/reflow warnings in the console. **Fix:** tag the newly-inserted root with `data-sl-hero-applied="1"` right after the first swap, and check for that marker at the top of the hero_html branch — skips all future re-application for the rest of the page's lifetime. Also flipped the query preference to check `[data-hero-container]` before `section.hero` (our own reliable marker first), though this wasn't the fix by itself since the self-match happens either way once the AI's fake wrapper exists.

**Bug B (real, page-inherent, not a code bug): the personalized container was legitimately hidden by the page's own CSS.** After fixing Bug A, added a loud visibility check (`getComputedStyle`, `offsetParent`) right after the swap applies — and it fired: `display=none`. Root cause, confirmed by inspecting the page's own stylesheet: this messy Unbounce export reuses the same `id="lp-pom-box-28"` on 3+ *unrelated* elements (decorative illustration boxes hundreds of pixels further down the page), one of which has `display:none` in its CSS rule. Since HTML ids are supposed to be unique but aren't here, the browser's CSS cascade applies that unrelated `display:none` rule to **every** element sharing the id — including our correctly-detected, correctly-injected hero container. This is a pre-existing defect in the uploaded HTML itself (would have broken *any* selector-based personalization approach, not just ours) — not something detection or the swap script did wrong. Confirms exactly the risk the user flagged going in ("Unbounce HTMLs are really shitty... duplicate stuff for different devices") — just a different flavor (colliding ids, not duplicate responsive headings) than originally anticipated.

**Decision on how to handle Bug B's class of failure (user chose, 2026-07-31):** verify visibility at swap-time client-side, not by rejecting candidates during server-side detection. Implemented: after the swap applies, check `getComputedStyle(newRoot).display/visibility` and `offsetParent`; if hidden, `console.warn` with a clear diagnostic pointing at the likely cause (colliding non-unique id) instead of failing silently. This doesn't fix pages with this defect, but makes the failure immediately diagnosable from the browser console on the next occurrence, rather than requiring a DB/CSS archaeology session like this one. Rejecting colliding-id candidates during server-side detection was considered and explicitly not chosen — left as a possible future improvement if this recurs often enough to be worth the added detection complexity.

**Debugging method worth keeping for next time:** `puppeteer-core` pointed at the system's already-installed `google-chrome` (`/usr/bin/google-chrome`) let this get diagnosed in minutes instead of guessing — loaded the real served URL, captured console output, waited past the observer's 10s window to rule out delayed reversion, and read `getComputedStyle`/`getBoundingClientRect` on the actual container to catch the CSS-visibility issue directly. No new package installed; `puppeteer-core` was already a project dependency.

## Session notes (2026-07-31, later still) — decision to lead with revamp on raw HTML, container-first detection redesign

Client wants the full hero-revamp experience on raw/uploaded HTML too, not just AI-generated pages, and wants token cost kept low. Root cause of Bug 2/Bug 3 above (never-succeeding container detection on `titan.html`) is architectural: the container is currently derived as a *side effect* of full field detection (find all 4 fields → compute common ancestor), which is a much harder/noisier AI task than "find the one wrapper element that is the hero section," and the two independent call sites (`generateHeroRevamp`/`generateHeroOverrides`) never agreed with each other.

**Decision: flip the order.** Detect the container first, with a small, cheap, container-only AI call (shallow block-level candidates only — tag/id/class/child-count/one text preview per candidate — not the full leaf-level field dump). Once a container is found, wrap it with the existing `<!-- SL:hero -->` marker convention and persist — one-time, ever, per page, exactly like AI-generated pages already get for free. Field detection (for the field-swap fallback) becomes a separate, later step, scoped to just the container's subtree instead of the whole document — far fewer candidates, so the earlier `MAX_CANDIDATES=400` workaround stops being load-bearing.

This also resolves a previously-unflagged correctness gap: Unbounce-style exports duplicate the same heading/CTA multiple times for different responsive breakpoints (mobile/tablet/desktop). A full-container `outerHTML` swap (the revamp path) naturally keeps all of them in sync since the whole subtree is replaced together. The field-swap path does **not** get this for free — `utm-swap-script.ts`'s field loop uses `document.querySelector` (single-element), so if only one duplicate got tagged with `data-field`, other breakpoints would silently keep stale default content after a swap. Two fixes required together, not one: (a) tag *all* near-duplicate elements with the same `data-field` during injection, and (b) change the swap script to `document.querySelectorAll` and apply to every match. Confirmed non-breaking for AI-generated pages: `data-field` is already unique per field there, so iterating a length-1 list is identical behavior.

### Todos agreed (not yet implemented)

- [ ] Add `detectHeroContainerRawHtml()` — new, cheap, container-only AI call in `hero-field-detection-raw.ts` (shallow block-level candidates only, not the full leaf field list).
- [ ] On container found: wrap it with the existing `<!-- SL:hero -->`/`<!-- /SL:hero -->` markers + `data-hero-container="1"`, persist `html_content`/`html_url` once (same mutation pattern as today, just triggered once per page instead of on every cron run).
- [ ] Rewrite `generateHeroRevamp()` in `auto-personalize.ts` to call the new container-only detector when the marker/`class="hero"` regex misses — remove its dependency on full field detection to derive the container.
- [ ] Add a container-scoped variant of `detectAndInjectHeroFieldsRawHtml()` (reuse existing candidate-collection/injection logic, but rooted at the `SL:hero` container's subtree, not the whole document) for the field-swap fallback path.
- [ ] Update `generateHeroOverrides()` in `auto-personalize.ts` to only run field detection after a container marker exists (triggering container detection first if missing), instead of independently re-running full-page field detection.
- [ ] Fix Unbounce responsive-duplicate handling: when injecting `data-field` attributes, tag ALL near-duplicate elements (same/near-identical text) with the same value, not just the first match.
- [ ] Fix `utm-swap-script.ts`'s field-swap loop: `document.querySelector` → `document.querySelectorAll` for `overrides_json` field application, updating every matched element. Confirmed no-op for AI-generated pages (fields are already unique there).
- [ ] Regression-safety check: confirm AI-generated pages are unaffected by both changes above before considering this done.
- [ ] Verify with `tsc --noEmit` and `npm run build` after each logical change.
- [ ] Manual test against `docs/titan.html` (same reset procedure as the earlier raw-HTML testing session) — confirm single AI call for container detection, successful revamp, and correct multi-element duplicate updates if the field-swap path is exercised.

Net effect once done: container detection runs at most once per page, ever (persisted marker) — no more per-cron-run non-determinism, no more disagreement between the two call sites, lower token cost (small container-only prompt instead of a full leaf-candidate dump), and the field-swap fallback becomes correct on responsive-duplicate markup instead of silently stale.
