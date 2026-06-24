--

## TODOS — Phase 1

### DB
- [x] **Migration 026** — Add `schema_json JSONB`, `conversation_json JSONB` to `pages`. (`prompt`, `vertical`, `source_type`, `version`, `html_url`, `html_content` already exist from migration 015.) ✅ Done
- ~~**Migration 027**~~ — Not needed. `form_leads` table already handles form submissions via `tracker.js`.
- No `personalization_rules` table in Phase 1 — UTM personalization deferred.

---

### API Routes (Backend)

- [x] **`POST /api/pages/generate`** — receives `{ prompt, vertical, conversation_json }`. `vertical` is explicit from the frontend selector, injected into system prompt to bias structure. Returns `{ type: 'questions', questions: [] }` or `{ type: 'schema', schema: {} }`. No DB writes. ✅ Done

- [x] **`POST /api/pages/build`** — receives `{ schema_json, slug? }`, calls Claude for full HTML/CSS with `data-field` attrs + SEO `<head>` + image fallbacks, uploads via `uploadHtml()`, returns `{ html_url, slug }`. `max_tokens: 8192`, markdown fence stripping, `<!-- TRACKER_PLACEHOLDER -->` for publish-time injection. ✅ Done

- [x] **`POST /api/pages`** — creates pages row with `{ workspace_id, name, prompt, vertical, schema_json, conversation_json, status: 'draft', source_type: 'ai', html_url, html_content, slug }`. `name` is collected from the user upfront in the UI. Existing `POST /api/pages/from-html` untouched. ✅ Done

- [ ] **`GET /api/workspaces/[id]/pages`** — already exists. Verify it returns `schema_json`, `conversation_json`, `vertical` after migration 026. ✅ Done


- [ ] **`GET /api/pages/[id]`** — already exists. Verify full record returned after migration 026. ✅ Done

- [ ] **`PATCH /api/pages/[id]`** — already exists. Extend zod schema to also accept `schema_json`, `conversation_json`, `status: 'draft' | 'active' | 'published'`.  ✅ Done

- [ ] **`DELETE /api/pages/[id]`** — already exists. No changes needed — already deletes from Storage via `html_url`. ✅ Done

- [ ] **`POST /api/pages/[id]/follow-up`** — receives `{ prompt, current_schema, current_html, conversation_json }`. Full conversation history sent to Claude for context. Claude decides change type and returns `{ type: 'structural', schema_json, html }` or `{ type: 'style', html }`. Structural → update `schema_json` + re-upload full HTML → return `{ schema_json, html_url }`. Style → re-upload patched HTML only → return `{ html_url }`. Route appends the new prompt + Claude response to `conversation_json` and saves it to DB. ✅ Done

- [ ] **`POST /api/pages/[id]/publish`** — sets `status: 'published'`, generates slug if not set. Reads current HTML from Storage, replaces `<!-- TRACKER_PLACEHOLDER -->` with `<script src="${NEXT_PUBLIC_APP_URL}/tracker.js"></script>` (env var resolved server-side at publish time, baked into static HTML), re-uploads to Storage, updates `html_content` in DB. In code it'll be:
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
const trackerScript = `<script src="${appUrl}/tracker.js"></script>`;
html = html.replace('<!-- TRACKER_PLACEHOLDER -->', trackerScript);
Same pattern used in /api/serve, /api/check-tracking, and tracker.js/route.ts. ✅ Done


- [ ] **`POST /api/pages/[id]/upload-image`** — receives file + `field_path`, uploads to `pages/[page_id]/` in Storage, updates `schema_json` with image URL, re-injects `<img src>` into HTML.
✅ Done

Bug 1 — setNestedValue clobbers arrays: ✅ Real. { ...[{name: "John"}] } spreads an array as { "0": {name: "John"} }. Any path through an array key destroys the array. ✅ Done

Bug 2 — fileNameFromUrl(page.html_url) called when html_url is null: ✅ Real. fileNameFromUrl receives url: string but page.html_url from the DB can be null. Calling .split() on null throws a TypeError at runtime, crashing the whole request — even if the image upload to Storage already succeeded. ✅ Done

Design gap-3 — No file size limit: ✅ Valid. No size check before arrayBuffer() means a huge upload will consume server memory and hit Supabase limits with a cryptic error. Should be a 5MB guard. ✅ Done


- [ ] **`GET /pages/[slug]`** — `src/app/pages/[slug]/route.ts`. Reads `html_url` from DB by slug, proxies HTML from Supabase Storage. Serves from `www.trysplitlab.com/pages/[slug]` in Phase 1 — no subdomain config needed.

Bug 1 — Missing deleted_at IS NULL filter ✅ Real bug.
Soft-deleted pages (deleted_at IS NOT NULL) are still served because the query only filters on slug + status. A deleted published page stays live forever.
SOLUTION: Now a soft-deleted page returns 404 even if its status is still published in the DB.




---

### Claude System Prompts

- [x] **Schema generation prompt** — JSON-only output, vertical bias from explicit selector, fixed section library (hero, benefits, social_proof, pricing, form, faq, team, video, footer), real content rule, clarifying questions logic (max 1 round, max 3 questions, "surprise me" escape hatch). ✅ Done (inside `/api/pages/generate`)

- [x] **HTML code generation prompt** — takes `schema_json`, returns full responsive HTML/CSS, `data-field` on every editable element, SEO `<head>` tags, CSS gradient fallback for null images, `<!-- TRACKER_PLACEHOLDER -->` comment.  (inside `/api/pages/build`) ✅ Done


- [ ] **Follow-up structural prompt** — receives `current_schema` + current HTML + instruction, returns `{ schema_json, html }`.
- [ ] **Follow-up style/patch prompt** — receives current HTML + instruction only, returns patched HTML. ✅ Done

---

### UI like lovable
- [ ] Create a new option & page "AI Generate" in sidebar of the app when user clicks it go to AI Generate page and do code, create components, follow best practices. UI will be like lovable. ✅ Done

- [ ] **Page builder layout** — two-column split: left panel (prompt input + conversation thread), right panel (iframe preview), top bar (status badge + publish button). Route: `/clients/[id]/pages/new`. ✅ Done

- [ ] **Prompt input component** — three inputs collected upfront before generation: (1) page name text input (required), (2) vertical selector (3 buttons: Lead Gen / SaaS / Local Services), (3) prompt textarea + Generate button. Name and vertical held in component state, sent with `POST /api/pages` after build completes. Vertical selector hidden after schema confirmed. ✅ Done



- [ ] **Conversation thread component** — shows user messages and Claude responses in chat style, scrollable. ✅ Done


- [ ] **Clarifying questions UI** — when API returns `{ type: 'questions' }`, renders each question as a labeled text input. Submit answers button + "Surprise me" button that sends `"surprise me"` as the prompt. ✅ Done

- [ ] **Generation progress indicator** — step-by-step: Analyzing prompt → Building structure → Writing content → Styling layout → Done. ✅ Done

- [ ] **Iframe preview pane** — renders HTML from `html_url`, refreshes when `html_url` changes, fade-in on load. ✅ Done

- [ ] **Inline text editing** — inject `contentEditable` script into iframe, click any `data-field` element to edit, debounced save on blur: `PATCH /api/pages/[id]` with updated `schema_json` + `html_content`. ✅ Done

- [ ] **Image upload UI** — click placeholder in preview → file picker → `/api/pages/[id]/upload-image` → preview refreshes. ✅ Done

- [ ] **Page management list** — extend `PagesClient.tsx` to show `vertical` badge (Lead Gen / SaaS / Local), `source_type` badge (AI / Manual), status. Add duplicate and builder-edit actions.

- [ ] **Duplicate page action** — copies `schema_json` + `conversation_json` + `vertical`, new slug, calls `/api/pages/build`, `status: 'draft'`.


- [ ] **Publish flow** — confirm dialog → `/api/pages/[id]/publish` → show `www.trysplitlab.com/pages/[slug]` → copy to clipboard. ✅ Done

-[ ] Follow lovable screenshots for UI

### FE BUGS RESOLVED:
Bug 1 — iframeSrc is now a stable state value set only inside a useEffect that runs when htmlUrl changes. Typing in chat no longer reloads the iframe.
Bug 3 — setSchemaJson is now a pure call. The setTimeout + fetch side effect runs outside the setter, using schemaRef (a ref that mirrors schema state) to read the latest value safely without stale closure issues.

### Plan Limits & Access Control

- [ ] **Add `pages` limit to `PLAN_LIMITS`** in `src/lib/plans.ts` — `free: 1, pro: 5, agency: 25, scale: Infinity`. Enforce in `POST /api/pages`.
- [ ] **Access control** — manager+ can create/edit/delete/publish, viewer read-only. Use existing `resolveWorkspaceRole` pattern on all new routes.

---

### Verification
- [ ] **`npm run build`** — no type errors after all changes.

-----------------------------------------
### EDGE CASES:

1. Follow-up route — context window growth
Line 68 sends the full HTML inside the user message:
const userMessage = `Current schema:\n...\n\nCurrent HTML:\n${html}\n\nInstruction: ${prompt}`;


-----------------------------------------
### BUG 
when I hit followup API preview disappeared, I dont think so lovable does that i: