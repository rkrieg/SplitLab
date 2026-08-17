# Element picker for AI edits — plan

**Status: Not started.** Design discussed and agreed at a high level; todos
below are unimplemented.

## Background

### The ask

Client wants a Lovable/Replit-style "element picker" in the AI editor:
toggle a select tool, hover the live preview to see candidate elements
outlined in blue, click one to lock it in (single selection only, solid blue
border + a small tag like `h1` or `section`), and have that selection appear
as a removable chip in the chat composer. Typing a prompt afterward should
scope the AI's edit to that element/section instead of relying on the model
to guess what "this" or "it" refers to.

This is explicitly **not** a new edit pathway — it's a scoping *hint* fed
into the AI edit flow that already exists. No new patch verb, no new API
route.

### Applies to both AI Pages entry points, by construction

`AIBuilderClient.tsx` is the single shared editor component behind two
different entry points:

- **Build with AI** (`pages/ai/create`, `ai-pages/new`) — prompt →
  `/api/pages/generate` → `/api/pages/build`, landing in `phase === 'editing'`
  for refinement before publish.
- **Edit with AI** (`AnalyticsClient.tsx` "Edit with AI" / "Edit using AI"
  buttons on a test variant) — opens the same component directly into
  `phase === 'editing'` against an existing page/draft.

Both cases render the same preview iframe, the same follow-up composer, and
hit the same `POST /api/pages/[id]/follow-up` route. **One implementation in
`AIBuilderClient.tsx` + `follow-up/route.ts` covers both flows** — there is no
divergent logic to duplicate. The only thing to verify explicitly is that the
picker is gated on `phase === 'editing'` (see Todo 1), which both flows reach.

### Key existing pieces we're building on top of (do not modify their core logic)

- **Preview iframe**: same-origin `<iframe src={iframeSrc}>`
  (`AIBuilderClient.tsx:2375-2377`), `iframeRef` at line 442. Same-origin means
  `iframe.contentDocument` is directly accessible — no postMessage is
  *required* for hit-testing, but we'll keep using postMessage for the
  select/deselect signal since that's the established pattern for
  `sl_field_edit` / `sl_image_click`.
- **`injectPreviewEditor(doc)`** (`AIBuilderClient.tsx:772`) — injects the
  script that makes `[data-field]` elements contentEditable/clickable today.
  We extend this, not replace it.
- **Parent message handler** (`AIBuilderClient.tsx:723-767`) — existing
  `window.addEventListener('message', handleMessage)` switch on `e.data.type`.
  We add new cases here.
- **`<!-- SL:name -->` / `<!-- /SL:name -->` markers** — already wrap every
  top-level section in AI-built HTML (`ai-page-builder.ts` system prompt,
  `ai-sl-markers.ts` repair/wrap pass). These are HTML *comments*, not part of
  the DOM element tree, so they can't be queried with `closest()` directly —
  the injected script must resolve them once via `TreeWalker` and stamp a
  temporary `data-sl-section="name"` attribute on the enclosed element.
- **`data-field="section.field"` attributes** — already stamped on every
  editable leaf node (`ai-data-field-stamp.ts`, `ensure-editable` route). This
  gives us field-level granularity for free; no new attribute scheme needed.
- **`classifyEditIntent()`** (`ai-edit-intent.ts:649`) — the single model call
  that decides `asks[].sections`, `op`, `designMatch`, etc. This is where the
  selection gets fed in as grounding context — deliberately not a hardcoded
  bypass, consistent with the existing "classifier decides, code applies and
  verifies" architecture (see the file's own header comment).
- **`normalizeIntent()`** (`ai-edit-intent.ts:741`) — already validates every
  section name the model returns against the live `sectionNames` list. Our
  fallback (Todo 9) reuses this same validation, it doesn't bypass it.
- **`runScopedPatch` / `runRegionRewrite`** (`follow-up/route.ts`) — unchanged.
  A resolved section-level selection routes into the existing scoped-patch
  path; a field-level selection just adds a sharper instruction string, still
  going through the same region-rewrite call and its "Silence means KEEP"
  contract.
- **Follow-up request body** (`AIBuilderClient.tsx:1348-1356`) — currently
  `{ prompt, current_schema, image_urls? }`. We add one optional field,
  `target_selection`, following the same "omit when absent" convention already
  used for `image_urls`.
- **Composer chip UI** (`AIBuilderClient.tsx:2062-2088`) — existing
  image-attachment chip pattern (thumbnail + hover `✕`). Clone this for the
  selection chip (label instead of thumbnail).

## Decisions made (do not re-litigate without new info)

1. **Granularity: section-level AND field-level.** Selecting a whole section
   (nav, hero, footer, …) or a single `data-field` leaf (a heading, image,
   button) are both supported. Resolution order on click: nearest
   `[data-field]` ancestor wins; if none, fall back to nearest
   `[data-sl-section]` ancestor.
2. **Selection is a hint, not an override.** It's injected into
   `classifyEditIntent`'s context as a stated fact ("the user selected this
   exact element"), not used to skip classification or force `ask.sections`
   unconditionally. This matters for messages that mix a selection-scoped ask
   with an explicit different-section ask in the same sentence ("make this
   bigger and also change the footer color") — the model must still be free to
   route the second ask elsewhere. A hardcoded override would break that.
3. **Single selection only**, enforced client-side: selecting a new element or
   clicking empty space clears the previous one. No multi-select.
4. **Pick mode and inline click-to-edit are mutually exclusive.** Toggling
   pick mode on suspends the existing always-on `contentEditable`/image-click
   behavior for the duration, to avoid a click doing two things at once.
5. **No parent-drawn overlay.** Highlighting is done with CSS
   outline/box-shadow set directly on the DOM node inside the iframe — the
   same technique already used for `data-field` hover — not a
   `getBoundingClientRect()`-based overlay layer in the parent. Keeps this
   consistent with existing code and avoids new scroll/resize coordinate math.
6. **No new API route, no new patch verb.** `target_selection` is an optional
   field on the existing follow-up payload; it terminates in existing
   classify → dispatch → scoped-patch/region-rewrite code paths.

## Edge cases to handle (checked against both flows)

- **Phase gating**: pick mode must only be offered in `phase === 'editing'`.
  During `'generating'`/`'building'` the iframe content is still streaming/
  reloading — selecting mid-stream would select a node that's about to be
  replaced. Disable/hide the toggle outside `'editing'`.
- **Re-injection after every apply**: the iframe reloads (or its DOM is
  replaced) after every successful edit — the existing `onLoad` re-injection
  (`AIBuilderClient.tsx:828-830` and inline near `:2400`) must also re-run the
  section-map `TreeWalker` pass and re-bind pick-mode listeners, since the old
  DOM nodes (and any `data-sl-section` attributes stamped on them) no longer
  exist.
- **Stale selection after an edit**: if the just-applied edit removed,
  renamed, or merged the selected section (e.g. classifier's `deleted` array,
  or a rename via `dedupeSectionName`), the chip must be cleared automatically
  rather than silently pointing at something that no longer exists. Detect via
  the post-edit section list not containing the previously selected name.
- **Selection during an in-flight request**: once the user hits send with a
  selection attached, lock the picker (or at minimum don't let them pick a
  *different* element) until the response lands, to avoid a race between "user
  reselects" and "server processes the old selection."
- **Nested/ambiguous targets**: clicking a button *inside* a card *inside* a
  section must resolve to the nearest `[data-field]`, not the whole section —
  explicitly test icon-in-button, image-in-card, text-in-nested-div cases.
- **Elements with no `data-field` and no enclosing `data-sl-section`**: can
  happen on pages missing markers (see "schema-less variants" below). Decide
  and implement a clear fallback: either disable selection entirely for that
  node (cursor shows "not selectable") or degrade to "whole page" scope with
  no chip claim of precision. Do not silently select nothing while showing a
  selected-looking outline.
- **Schema-less / raw-HTML test variants** (`schema_json: null`, no `<!--
  SL:name -->` markers yet — see `docs/edit-html-with-ai-todos.md`): picker
  must degrade gracefully before `schema-from-html` / marker-repair has run.
  Confirm whether markers exist by the time `phase === 'editing'` is reached
  for this path, and if not, either block pick mode with a tooltip or trigger
  marker repair first.
- **Duplicate section names** (`ai-sl-markers.ts` dedup suffixes like
  `features-2`): selection must capture the exact deduped name, not the base
  name, so the backend targets the right one.
- **Selection + attached image in the same message**: must not conflict in
  `attachmentRoles`/`designMatch` resolution — the selection says *where*, the
  image role logic (locator/design_reference/etc.) still governs *what the
  image is for*, independently.
- **Selection + multi-ask message**: confirm the classifier prompt update
  (Todo 8) makes clear the selection grounds only the ask(s) that plausibly
  refer to "this/it", not every ask in a multi-part instruction.
- **Stale/invalid section by the time the backend processes it** (e.g. another
  browser tab or a concurrent edit changed the page first): must not trust
  `target_selection.section` blindly — validate against the live section list
  the same way `normalizeIntent()` already validates model-returned section
  names, and silently drop the hint if it no longer matches.
- **Draft vs. live HTML for test variants**: `pages.draft_html_content` staging
  (`docs` note this exists for variant edits) — confirm the iframe is showing
  draft content when a draft exists, so the section map built by the picker
  matches what the backend will actually patch.
- **Touch/mobile preview**: out of scope for v1 — desktop mouse hover/click
  only. Note explicitly rather than leaving it ambiguous.
- **Rate limits/credits**: selection adds no new model call (it *removes* the
  need for `resolveSectionsForAsk` in the common case) — confirm no double
  billing/rate-limit consumption is introduced.

## Todos

### Frontend (`AIBuilderClient.tsx`)

- [ ] Add `pickMode` state + toggle button in the composer/preview toolbar,
      enabled only when `phase === 'editing'`.
- [ ] Extend `injectPreviewEditor(doc)` (or a sibling function called from the
      same injection point) to, when pick mode is active:
  - [ ] Run the `TreeWalker` pass mapping `<!-- SL:name -->`/`<!-- /SL:name
        -->` comment pairs to their enclosed element, stamping
        `data-sl-section="name"` (in-memory only).
  - [ ] Bind a `mousemove` listener that resolves the hovered target
        (`closest('[data-field]')` else `closest('[data-sl-section]')`) and
        applies a dashed outline; clears outline when leaving pick mode.
  - [ ] Bind a `click` listener that locks the resolved target, applies a
        solid outline, and clears any previously-locked element.
  - [ ] Suspend existing `data-field` contentEditable/image-click bindings
        while pick mode is active (Decision 4).
  - [ ] `postMessage` a `sl_element_select` event with `{ section, field,
        tag, text }` on click; `sl_element_deselect` on clear/background
        click.
- [ ] Re-run the injection (map + listeners) on every iframe reload, not just
      first load (Edge case: re-injection).
- [ ] Add `sl_element_select` / `sl_element_deselect` cases to the existing
      `handleMessage` switch, driving a new `selectedElement` state.
- [ ] Clear `selectedElement` automatically when a follow-up response removes
      or renames its section (Edge case: stale selection).
- [ ] Render the selection chip in the composer (clone the image-chip pattern
      at `:2062-2088`), with a remove button that also posts a clear message
      into the iframe to drop the locked outline.
- [ ] Lock re-selection while a follow-up request is in flight (Edge case:
      in-flight race).
- [ ] Add `target_selection` to the follow-up fetch body
      (`:1348-1356`), only when `selectedElement` is set.
- [ ] Handle the no-marker fallback path for schema-less variants (decide:
      block with tooltip vs. degrade) per the edge case above.

### Backend (`ai-edit-intent.ts`, `follow-up/route.ts`)

- [ ] Add optional `target_selection` to the follow-up route's request body
      parsing.
- [ ] Validate `target_selection.section` against the page's live
      `sectionNames` before using it for anything (never trust the client
      blindly — same posture as every other input into `normalizeIntent`).
- [ ] Thread the validated selection into `classifyEditIntent()`'s context
      string as a stated fact (alongside `sectionOutline`/`conversation`), per
      Decision 2 — not a parameter that short-circuits classification.
- [ ] Update the classifier's system prompt (`SYSTEM` in `ai-edit-intent.ts`)
      with guidance on how to use a supplied selection: ground ambiguous
      "this"/"it" asks to it, but don't force every ask in a multi-ask message
      onto it.
- [ ] Add the safety-net fallback in `normalizeIntent()`: if an ask's
      `sections` comes back empty and a validated `target_selection.section`
      exists, fill it in deterministically (this is legitimate — it's
      user-supplied ground truth, not a keyword guess, so it doesn't reintroduce
      the keyword-fallback pattern the classifier replaced).
- [ ] For field-level selections, pass the specific `data-field` name through
      to whichever scoped-patch/region-rewrite call ends up handling that ask,
      so the rewrite instruction names the exact element rather than just the
      section.
- [ ] Confirm `resolveSectionsForAsk()` is skipped (not called) when a
      validated selection already resolved the ask's sections — avoids an
      unnecessary extra model call.

### Testing / verification

- [ ] Manually verify the picker in both entry points: fresh **Build with
      AI** page still in `'editing'` phase pre-publish, and **Edit with AI**
      opened on an existing published test variant.
- [ ] Verify schema-less raw-HTML variant behavior explicitly (with and
      without markers already repaired).
- [ ] Verify a multi-ask message ("make this bigger and change the footer
      too") with a selection attached routes correctly — selection scopes the
      first ask, footer ask still resolves independently.
- [ ] Verify selecting, then sending a message that clearly asks for something
      broader ("redesign the whole page") does not get incorrectly narrowed by
      the selection hint.
- [ ] Verify chip clears correctly when the edit response deletes/renames the
      selected section.
- [ ] Verify duplicate-name sections (`features-2`) select the correct
      instance.
