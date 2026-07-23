# "Edit using AI" for raw HTML test variants — plan

**Status: Shipped.** All todos below are done except #7 (list badge), which
was deliberately dropped in favor of a different fix (see Implementation
notes at the bottom) — the underlying confusion it was meant to solve
(where does this page "live"?) got addressed via the breadcrumb/back-nav
fixes instead.

## Background

### The ask

Non-technical agency clients edit variant HTML today through a raw CodeMirror
modal (`AnalyticsClient.tsx`, "Edit HTML — Variant X"). They have no idea how
to make even small changes to raw HTML/CSS. Client want a button in that modal
("Edit using AI") that sends them into a prompt-driven editor instead —
"reduce the size of the header," etc. — same pattern already used for the
existing AI Pages product.

### Why this isn't a trivial "reuse AI Pages" ticket

Two systems already share one `pages` table but were built independently:

- **AI-built pages** (`ai-pages` flow): created via `/api/pages/generate` →
  `/api/pages/build`. Populate `schema_json` (structured section data) *and*
  `html_content`/`html_url` (the rendered output). The `AIBuilderClient` editor
  UI depends on `schema_json` for two things: inline WYSIWYG click-to-edit
  (via `data-field` attributes baked into the schema-rendered HTML) and
  schema-level structural rebuilds.
- **Raw/manual HTML pages** (test variants, created via `/api/pages/from-html`
  or hand-edited in the `AnalyticsClient` modal): have `html_content`/`html_url`
  but **`schema_json: null`**. No `data-field` markers, no `<!-- SL:name -->`
  section markers (until an AI edit adds them).

`test_variants.page_id → pages.id` already links a variant directly to its
`pages` row — so routing "Edit using AI" to the AI Pages editor for that same
`page_id` requires no new sync mechanism; edits there already land on the live
variant. The actual gap is that the AI Pages *editor UI* assumes a schema
exists and doesn't degrade gracefully without one.

### Key existing pieces we're building on top of (do not modify their core logic)

- `POST /api/pages/generate` — prompt → schema (brand-new pages only).
- `POST /api/pages/build` — schema → HTML.
- `POST /api/pages/[id]/follow-up` — chat-based edit of an *existing* page.
  Classifies each instruction into:
  - `patch` — 1-3 sections, requires existing `<!-- SL:name -->` markers.
  - `style` — 4+ sections or no markers → full HTML rewrite returned directly
    by the AI, markers, **no schema required**.
  - `structural` — add/remove/reorder sections → AI returns a fresh
    `schema_json`, server calls `buildHtmlFromSchema()` to rebuild the whole
    page (schema can be synthesized from scratch even if none existed before —
    confirmed by reading the route, this already works for schema-less pages
    as-is).
  Already handles clearing `field_selectors_json`/personalization rules when
  HTML changes.
- `PATCH /api/pages/[id]` — generic page update (used by both the raw HTML
  modal and inline WYSIWYG autosave). Currently clears
  `field_selectors_json`/personalization rules on HTML replace, but **does
  NOT clear `schema_json`** — this is a real bug (see Todo 6).
- `AIBuilderClient.tsx` — the shared editor component for both `ai-pages/new`
  and `pages/ai/create`. Renders WYSIWYG inline editing via a `data-field`
  content-editable overlay injected into the preview iframe.
- Plan gate: `PLAN_LIMITS[ownerPlan].aiPages` (Agency/Scale only, admin
  bypasses). Rate limits: `generate`/`build` 3/min+15/hr,
  `follow-up` 5/min+30/hr. Reuse as-is — no new gating logic needed.

## Decisions made (do not re-litigate without new info)

1. **Structural rebuilds are allowed** for raw-HTML variant pages, accepting
   that a big AI change may reflow the design into SplitLab's own templates
   rather than preserving hand-coded markup exactly.
2. **Schema generation is triggered automatically in the background** the
   moment the user lands on the AI editor for a schema-less page — not lazily
   on first classified structural edit, and not blocking on the user's first
   prompt. This is a **dedicated, separate, idempotent route**
   (`/api/pages/[id]/schema-from-html`), NOT a change to `generate`, `build`,
   or `follow-up`.
3. **Must be idempotent**: only fires when `schema_json === null`; once set,
   never called again for that page (guard both client-side, before firing,
   and server-side, in case of double-invocation).
4. **Do not modify existing AI Pages core functionality** — the new behavior
   must be additively gated so it never triggers for normal brand-new AI-built
   pages (which already get a schema during creation and thus never match the
   `schema_json === null && html_content exists` condition).
5. Because background schema-gen and a user-submitted prompt both write to the
   same `pages` row, they must not run as truly independent concurrent calls
   (risk of a lost update). Resolution: **serialize the write, not the UX** —
   start the background call immediately on page load, let the user type
   freely, but disable/queue prompt submission ("Preparing this page for
   editing…") until the background call's write completes, then auto-enable
   or auto-fire.
6. Old raw HTML CodeMirror modal in `AnalyticsClient.tsx` stays as-is for
   quick edits — this feature is additive, not a replacement.

## Todos

1. [x] **Entry point** — Add "Edit using AI" button to the HTML modal footer in
   `AnalyticsClient.tsx` (~line 5287-5298, next to Close/Save-and-Close).
   Navigates to `clients/[id]/ai-pages/new?page_id=<variant.page_id>`.
   Shipped with a click-loader + disabled state while HTML is still loading.

2. [x] **New route: `POST /api/pages/[id]/schema-from-html`** — only valid when
   `schema_json === null` and `html_content`/`html_url` exists. Same
   auth/plan-gate/rate-limit pattern as `generate`/`follow-up`. Server-side
   re-checks `schema_json === null` before doing any work (idempotency guard
   against double-fire). **Implementation deviated from the original plan —
   see notes below**: does NOT call `buildHtmlFromSchema()` / redesign the
   page. Instead does a single AI "annotation pass" (add `data-field` +
   `<!-- SL:name -->` markers only, byte-for-byte preserve everything else),
   then derives `schema_json` deterministically via a regex parser reading
   those attributes back out — no second AI call, no visual drift.

3. [x] **`AIBuilderClient.tsx` — new isolated effect**: if the loaded page has
   `html_content` but `schema_json === null`, fire `schema-from-html` once on
   mount. Must not affect the existing generate→build flow for brand-new
   pages (condition never matches those). While in flight, shows a "Preparing
   this page for editing…" state and disables/queues the chat send button;
   auto-enables once the call completes and `schema_json` is set.

4. [x] **WYSIWYG behavior for schema-less pages**: resolved by the send-button
   gating in Todo 3 — the schema-less window is short-lived and the opening
   chat message no longer promises click-to-edit before it's ready (see
   Implementation notes).

5. [x] **Chat wiring**: `follow-up` used completely unmodified — no
   special-casing needed for classification (`patch`/`style`/`structural`
   all behave normally). `follow-up/route.ts` was never touched.

6. [x] **Bug fix — `PATCH /api/pages/[id]/route.ts`**: when `html_content` is
   manually replaced (raw modal save) and the page already has a
   `schema_json` that the caller did NOT also send, null out `schema_json`
   and `conversation_json` too — previously only `field_selectors_json`/
   personalization rules were cleared, leaving `schema_json` stale and
   mismatched with the actual HTML.

7. [ ] **List badge** — dropped, see Implementation notes.

8. [x] **Regression check** — confirmed: both the raw modal and the AI editor
   path go through the same underlying `pages` update logic, so the "saving
   new HTML clears UTM field mappings" warning behavior is consistent across
   both.

## Implementation notes / deviations from plan

- **Todo 2 was redesigned mid-build after a real-world test.** The original
  plan (reverse-engineer a schema, then run it through the normal
  `buildHtmlFromSchema()` page-generation pipeline) shipped first, but on a
  real client page it visibly reflowed the design — a hand-built floating
  "trust bar" element that overlapped two sections vanished entirely, because
  `buildHtmlFromSchema()` doesn't clone markup, it *designs a new page* from
  a text schema plus a one-line style note. That's unacceptable for existing,
  already-designed client pages. Replaced with the annotate-in-place +
  deterministic-schema-derivation approach described above — zero redesign
  risk, since the AI is only allowed to add attributes/comments, never change
  markup, styling, or structure.
- **`cheerio` was tried and reverted** for the schema-derivation step — its
  `undici` transitive dependency uses private class fields that broke this
  project's webpack/SWC build. Replaced with a small hand-written regex
  parser (same style as `follow-up/route.ts`'s own `applyPatch` regex logic).
- **Streaming fix**: `schema-from-html`'s AI call now always passes a
  (no-op) `onChunk` callback to force the streaming code path in
  `ai-client.ts` — at `maxTokens: 32000` a non-streaming call risks hitting
  the Anthropic SDK's HTTP timeout, per that file's own comments on why
  `build`/`follow-up` always stream.
- **Todo 7 (list badge) dropped.** Investigation showed the AI Pages list
  query filters `.eq('source_type', 'ai_generated')`, so raw/manual pages
  (including test-variant pages) never appear there at all — changing that
  filter risked touching shared list/pagination behavior for an unrelated
  feature. Instead, the actual UX problem it was meant to solve (user unsure
  where "back" goes, or what page they're even editing) was fixed more
  directly:
  - `backPath` for a test-variant page now points at that test's Analytics
    page (`/clients/[id]/tests/[testId]`), not the AI Pages list.
  - Breadcrumb shows `test-name / variant-name / AI Generate` instead of the
    client name, so it's unambiguous which test+variant is open.
  - Publish button is replaced with a "Changes save live automatically" label
    + an explicit **"Back to Test"** action (there's no publish step for
    these pages — they're served live straight from this `pages` row via
    `/api/serve`, so Publish would only create an unused, unrelated
    `trysplitlab.com/pages/<slug>` URL). Confirmed via `/api/serve`'s
    `stripSplitLabTrackerTags()` that this also carries no double-tracking
    risk even if a variant page were ever published by mistake.
  - Opening chat message is conditional on whether the page arrived with a
    schema already (`Welcome back...`) or not (explains prep is happening,
    invites a prompt instead of a false "click any text" promise).
