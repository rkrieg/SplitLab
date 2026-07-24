# "Edit using AI" for raw HTML test variants — handoff

Session continuation doc. Read alongside `docs/edit-html-with-ai-todos.md`
(the original plan + decisions log — still accurate for background/context,
now marked done). This file is: what shipped, what's still broken/pending,
and where to pick up.

## What shipped this session

1. **Entry point** — "Edit using AI" button in the raw HTML modal footer
   (`AnalyticsClient.tsx`, ~line 5289-5297), next to Close/Save-and-Close.
   Shows a spinner and disables while HTML is still loading or navigation is
   in flight. Navigates to `clients/[id]/ai-pages/new?page_id=<variant.page_id>`.

2. **`POST /api/pages/[id]/schema-from-html`** (new route) — prepares a
   schema-less raw-HTML page for the AI Pages editor. Current implementation:
   one AI call asks Claude to **annotate the existing HTML in place**
   (`data-field="..."` attributes + `<!-- SL:name -->` markers only — system
   prompt explicitly forbids any other change), then a regex-based parser
   (`deriveSchemaFromAnnotatedHtml`, no AI) derives `schema_json`
   deterministically by reading those attributes back out of the returned
   HTML. Idempotent (checks `schema_json === null` before and after, atomic
   `.is('schema_json', null)` update guard). Plan-gated (Agency/Scale),
   rate-limited same as `follow-up`. `maxDuration = 300` (was 120 — a real
   504 was hit on dev at 120s; see Known issue #1 below for why it's still
   slow even at 300s).

3. **`AIBuilderClient.tsx`** — new isolated `useEffect` fires
   `schema-from-html` once on mount when a page has HTML but no schema
   (never fires for normal brand-new AI-built pages). While in flight:
   chat input disabled with a "Preparing this page for editing…" placeholder,
   send button disabled, visible loading indicator in the thread. On success:
   toast + a new assistant chat message ("Done preparing this page!..."). On
   failure: toast, but chat/`follow-up` (`patch`/`style` modes) still work
   without a schema, so it's a soft failure.

4. **Bug fix — `PATCH /api/pages/[id]/route.ts`** — when `html_content` is
   replaced without the caller also sending a matching `schema_json` (i.e.
   the raw modal's manual save), any existing `schema_json`/`conversation_json`
   is now nulled out too. Prevents a stale schema silently overwriting manual
   edits on the next AI structural edit. Was a pre-existing bug, now directly
   relevant since users bounce between the raw modal and the AI editor.

5. **Publish → "Back to Test"** — for pages linked to a `test_variants` row
   (`isTestVariantPage`, computed server-side in `ai-pages/new/page.tsx` by
   querying `test_variants.page_id`), the Publish button is replaced with a
   "Changes save live automatically" label + an explicit green "Back to Test"
   button (routes to `/clients/[id]/tests/[testId]`). Confirmed via
   `/api/serve`'s `stripSplitLabTrackerTags()` that even an accidental
   Publish carries no double-tracking risk — it's just functionally useless
   for these pages (creates an unrelated, unused standalone URL), not unsafe.

6. **Breadcrumb fix** — was showing the *client* name ("hubspot-fix-test")
   even when editing a specific test's variant. Now shows
   `test-name / variant-name / AI Generate` for test-variant pages (fetched
   via `test_variants.name` + `tests.name` in `ai-pages/new/page.tsx`,
   threaded through as `clientName`/`variantName` props — `clientName` is
   overloaded to carry the test name in this case, a bit of a hack, see
   Known issue #3). `backPath` also fixed to point at the test's Analytics
   page instead of the AI Pages list (which filters
   `source_type = 'ai_generated'` and is always empty for these pages —
   this is why Todo 7 in the plan doc, "list badge", was dropped in favor of
   this fix instead).

7. **Opening chat message** — conditional on whether `schema_json` existed
   at load. Schema-less: explains prep is happening, invites a prompt
   instead of falsely inviting "click any text to edit."

## Known issues / pending work — START HERE next session

1. **PRIMARY OPEN ITEM — `schema-from-html` is still slow, even at 300s
   maxDuration.** Root cause understood but not yet fixed: the AI call
   currently has to **echo the entire page's HTML back** token-for-token
   just to insert a handful of attributes — for a real page that's 16-32k
   output tokens, which is slow regardless of model or timeout config.
   Agreed direction (not yet built): redesign the AI call to return ONLY a
   compact list — `{"dot_path": "hero.headline", "match_text": "..."}` per
   editable element — and do the actual `data-field`/`<!-- SL:name -->`
   insertion **server-side via string matching**, never asking the model to
   reproduce the document. This should cut output tokens (and thus latency)
   from "size of the whole page" to "size of a short field list." This is a
   real rewrite of `deriveSchemaFromAnnotatedHtml` + the AI call in
   `schema-from-html/route.ts`, not a tweak — **this is the next thing to
   build.**

2. **Not tested live/in-browser this session.** Everything here was verified
   with `npm run build` (type-checks, compiles) after every change, but no
   actual manual click-through testing was done directly — the user has been
   testing in their dev environment and reporting bugs back turn by turn
   (the 504, the lingering "preparing" message, the wrong breadcrumb, etc.).
   Assume there may be more UI rough edges not yet surfaced. Test the full
   flow end-to-end: raw modal → Edit using AI → wait for prep → chat edit →
   manual code edit → Back to Test → re-open raw modal → re-open Edit using
   AI (should re-annotate from scratch since PATCH fix #4 nulls the schema).

3. **`clientName` prop is overloaded** in `AIBuilderClient.tsx` to carry the
   test's name instead of the client's name when `isTestVariantPage`. Works,
   but is a naming smell — if this file gets touched again, consider a
   cleaner `breadcrumbPrimaryLabel`/`breadcrumbSecondaryLabel` prop pair
   instead of overloading `clientName`.

4. **`cheerio` was tried and reverted** for HTML parsing (breaks the
   webpack/SWC build via its `undici` dependency's private class fields) —
   don't reintroduce it. The regex-based parser in `schema-from-html/route.ts`
   is the intentional replacement; if the field-list-based rewrite (item 1)
   needs HTML parsing again, stick to regex/string matching, not a DOM lib.

5. **Todo 7 (list badge distinguishing HTML-origin AI pages) was dropped**,
   not deferred — the breadcrumb/back-nav fixes (item 6 above) were judged a
   better fix for the actual confusion it was meant to solve. Only revisit if
   a new, different reason comes up to show that distinction in the list UI.

## Files touched this session

- `src/app/api/pages/[id]/schema-from-html/route.ts` (new)
- `src/app/api/pages/[id]/route.ts` (PATCH schema-invalidation fix)
- `src/app/(dashboard)/clients/[id]/tests/[testId]/AnalyticsClient.tsx`
  (button, loader, disabled states)
- `src/app/(dashboard)/clients/[id]/pages/new/AIBuilderClient.tsx`
  (background schema-prep effect, chat gating, Back to Test button,
  breadcrumb, conditional welcome/done messages)
- `src/app/(dashboard)/clients/[id]/ai-pages/new/page.tsx`
  (`isTestVariantPage`, `backPath`, `clientName`/`variantName` resolution)
- `docs/edit-html-with-ai-todos.md` (plan doc, updated to reflect what
  actually shipped vs. the original plan)

No changes were made to `/api/pages/generate`, `/api/pages/build`,
`/api/pages/[id]/follow-up`, or any other existing AI Pages core file —
that constraint held throughout.
