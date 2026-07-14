# SSE Streaming Events — Implementation Todos

## Goal
Replace the current fire-and-wait API responses on the build and follow-up routes with a real-time Server-Sent Events (SSE) stream. The user sees live progress as Claude works — step messages, image previews, and Claude's own narration — with no raw HTML/JSON/schema ever shown.

## What the user sees (target UX)

```
[Build route]
✏️  Generating your page schema...
✏️  "Creating a dark SaaS landing page with hero, features, and pricing"  ← Claude thinking
🖼️  Generating 3 images...
    [thumbnail] [thumbnail] [thumbnail]   ← appear one by one as each uploads
✏️  Building HTML...
✏️  Writing navigation bar                ← Claude STATUS markers, live
✏️  Building hero section
✏️  Adding features grid
✏️  Writing pricing section
✏️  Adding footer
✅  Done

[Follow-up route — structural]
✏️  Fetching devmoor.com...
✏️  Analyzing design...
✏️  "Redesigning with dark theme, mint accents, and diagonal marquee"  ← Claude thinking
🖼️  Generating 2 images...
    [thumbnail] [thumbnail]
✏️  Building HTML...
✏️  Writing navigation bar
✏️  Building hero section
✏️  Adding blog grid
✅  Done

[Follow-up route — style patch]
✏️  Applying changes...
✏️  "Changing the hero background to dark navy and updating button color"  ← Claude thinking
✅  Done
```

---

## SSE Event Schema (frontend contract)

All events are JSON, sent as `data: {...}\n\n` over the SSE stream.

```ts
// Step status message
{ type: "status", message: string }

// Claude's thinking field extracted from Pass 1 stream
{ type: "thinking", message: string }

// Claude STATUS marker extracted from Pass 2 stream
{ type: "section_status", message: string }

// Single image ready (emitted per image, not after all finish)
{ type: "image_ready", url: string }

// Fatal error (replaces HTTP error responses once stream is open)
{ type: "error", message: string }

// Stream complete — same payload as today's JSON response
{ type: "done", html_url: string, schema_json?: unknown, competitor_fetch_failed?: boolean }
```

---

## Pre-Implementation Fixes ✅ Done

- [x] Add `export const dynamic = 'force-dynamic'` to `src/app/api/pages/[id]/follow-up/route.ts` — required for Vercel to not buffer/cache the SSE stream (build route already has it)
- [x] Add `export const maxDuration = 300` to both `follow-up/route.ts` and `build/route.ts` — competitor URL flow can take 60-90s, Vercel Pro default is 60s, silent kill without this
- [x] Confirm `fetch` + `ReadableStream` reader is used on frontend, NOT `EventSource` — `EventSource` is GET-only, our routes are POST with a JSON body

---

## Backend Todos ✅ Done

### 1. SSE helper utility — `src/lib/sse.ts` (new file)

- [x] Create `createSSEStream()` — returns `{ stream: ReadableStream, controller: ReadableStreamDefaultController }` with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` headers
- [x] Create `sendSSE(controller, event)` — serializes event as `data: ${JSON.stringify(event)}\n\n` and enqueues it
- [x] Create `closeSSE(controller)` — enqueues final newline and closes the stream
- [x] Export `SSEEvent` type union covering all event shapes listed above

### 2. Streaming variant in `src/lib/ai-client.ts`

- [x] Add `askAIStream(options, onChunk: (text: string) => void): Promise<string>` — streams `text_delta` events to `onChunk` callback as they arrive, still returns full final text. Do NOT modify existing `askAI()` — it stays identical for any non-SSE callers
- [x] Keep `askAnthropic()` internal — `askAIStream` calls the same `anthropic.messages.stream()` but iterates `for await (const event of stream)` calling `onChunk` on each `text_delta`, then calls `stream.finalMessage()` at the end
- [x] Add optional `onImageReady?: (url: string) => void` callback parameter to `generatePageImages()` — call it immediately after each `uploadImage()` succeeds, before the next image starts. Callback is optional so existing callers (if any) don't break

### 3. Prompt changes — `src/app/api/pages/[id]/follow-up/route.ts`

- [x] Add `thinking` field rule to Pass 1 SYSTEM_PROMPT structural output shape:
  ```
  Structural change — return schema only, NO html field:
  {"thinking":"One sentence describing what you are about to do","type":"structural","schema_json":{...}}

  Style/patch change:
  {"thinking":"One sentence describing what you are about to change","type":"style","html":"<!DOCTYPE html>..."}
  ```
  Claude always emits `thinking` first — it appears in the first ~50 tokens of the stream so we can extract and show it immediately while the rest generates.

### 4. Prompt + signature changes — `src/lib/ai-page-builder.ts`

- [x] Add optional `onChunk?: (chunk: string) => void` to `BuildHtmlFromSchemaOptions` (the options type passed to `buildHtmlFromSchema()`). When provided, call `askAIStream()` internally instead of `askAI()` and forward each token chunk to `onChunk`. When absent, fall back to `askAI()` — existing callers are unaffected. **This is required for both the build route and follow-up Pass 2 to be able to extract STATUS markers from the live HTML stream — without it the routes never see the token stream at all.**
- [x] Add STATUS marker rule to the HTML build system prompt (applies to both `SYSTEM_PROMPT` and `COMPETITOR_SYSTEM_PROMPT`):
  ```
  ## Progress markers — REQUIRED
  Before writing each major HTML section, emit a status comment on its own line:
  <!-- STATUS: Writing navigation bar -->
  <nav>...</nav>
  <!-- STATUS: Building hero section -->
  <section class="hero">...

  Rules:
  - Only between top-level HTML blocks, NEVER inside <style> or <script> tags
  - Use plain natural language: "Writing X", "Building X", "Adding X"
  - One marker per section, not per element
  - Allowed sections: navigation bar, hero section, features grid, pricing section,
    testimonials, team section, blog grid, gallery, contact form, footer
  ```

### 5. Convert `src/app/api/pages/[id]/follow-up/route.ts` to SSE

- [x] Open SSE stream at the top of the POST handler — all responses go through the stream, including errors
- [x] Replace all `return NextResponse.json({ error: '...' }, { status: N })` calls that come AFTER stream opens with `sendSSE(controller, { type: 'error', message: '...' })` + `closeSSE(controller)` + `return response`. Calls BEFORE stream opens (session check, page fetch) can still use `NextResponse.json` since stream hasn't started
- [x] Emit step events at each pipeline stage:
  - `{ type: "status", message: "Fetching [hostname]..." }` — before `scrapeCompetitorUrl()`
  - `{ type: "status", message: "Analyzing design..." }` — before Pass 1 `askAIStream()`
  - `{ type: "status", message: "Applying changes..." }` — before Pass 1 for style patch
- [x] Extract `thinking` field from Pass 1 stream — accumulate `text_delta` chunks, as soon as regex `/"thinking"\s*:\s*"((?:[^"\\]|\\.)*)"` matches, emit `{ type: "thinking", message: match[1] }`. Use this safer regex (not `[^"]+`) so escaped quotes inside the thinking sentence don't truncate the match. Continue accumulating full JSON for `finalMessage()` parse
- [x] After Pass 1 JSON parsed, count `image_prompt` nodes, emit `{ type: "status", message: "Generating N image(s)..." }`
- [x] Pass `onImageReady` to `generatePageImages()` — emit `{ type: "image_ready", url }` per image
- [x] Emit `{ type: "status", message: "Building HTML..." }` before Pass 2
- [x] Pass `onChunk` to `buildHtmlFromSchema()` — the callback buffers incoming chunks, detects `<!-- STATUS: ([^>]+) -->` pattern, and emits `{ type: "section_status", message: match[1] }` immediately via `sendSSE`. This works because of the `onChunk` added to `BuildHtmlFromSchemaOptions` in todo 4. Accumulate full HTML for final processing.
- [x] After DB write completes, emit `{ type: "done", html_url, schema_json?, competitor_fetch_failed? }` then close stream
- [x] Add `request.signal` abort check between major steps (after scrape, after Pass 1, after image gen) — if `request.signal.aborted`, close stream and return early without spending more API credits
- [x] Wrap entire handler in try/catch — on uncaught error, emit `{ type: "error", message: "Internal server error" }` and close stream

### 6. Convert `src/app/api/pages/build/route.ts` to SSE

- [x] Open SSE stream at the top of POST handler
- [x] Replace error responses after stream opens with SSE error events
- [x] Emit `{ type: "status", message: "Preparing your page..." }` immediately when stream opens — the build route receives schema pre-built from `/api/pages/generate` (which is a separate JSON route, not SSE), so there is no live schema generation step here. This gives the user immediate feedback that work has started.
- [x] Emit `{ type: "status", message: "Generating images..." }` before `generatePageImages()`
- [x] Pass `onImageReady` to `generatePageImages()` — emit `{ type: "image_ready", url }` per image
- [x] Emit `{ type: "status", message: "Building HTML..." }` before `buildHtmlFromSchema()`
- [x] Pass `onChunk` to `buildHtmlFromSchema()` — same STATUS marker extraction logic as follow-up route. The `onChunk` callback in `BuildHtmlFromSchemaOptions` (todo 4) threads the token stream up to the route so it can detect and emit `section_status` events in real time.
- [x] After upload, emit `{ type: "done", html_url, slug, schema_json }` then close stream
- [x] Add abort check between image gen and HTML build

### 7. Strip STATUS comments before upload (both routes)

- [x] After `finalMessage()` returns full HTML in both routes, run `html.replace(/<!--\s*STATUS:[^>]*-->/g, '')` before passing to `uploadHtml()` — the `g` flag is required, strips ALL occurrences. Without `g` only the first is removed and the rest end up in the user's page.

---

## Frontend Todos ✅ Done

### 8. Shared SSE stream reader utility — `src/lib/use-sse-stream.ts` (new file)

- [x] Create `readSSEStream(response: Response, onEvent: (event: SSEEvent) => void): Promise<void>` — reads the `response.body` as a `ReadableStream`, decodes chunks, splits on `\n\n`, parses `data: {...}` lines, calls `onEvent` for each. Handles partial chunks across boundaries (buffer incomplete lines)
- [x] Export `SSEEvent` type matching the backend event schema above

### 9. Shared live progress UI component — `src/components/ai/LiveProgressPanel.tsx` (new file)

- [x] Accept props: `events: SSEEvent[]`, `isComplete: boolean`
- [x] Render step messages (`status`, `section_status`) as a vertical list with a spinning indicator on the latest, checkmarks on completed
- [x] Render `thinking` event as a distinct styled message (e.g. italic, indented, Claude icon) — not a step, more like a thought bubble
- [x] Render `image_ready` events as a horizontal thumbnail strip — images appear one by one as they arrive, not all at once
- [x] `section_status` events appear indented under the "Building HTML..." step — shows sub-progress within that step
- [x] Never render raw HTML, JSON, schema, or code to the user — only messages and image thumbnails
- [x] Smooth fade-in animation on each new event
- [x] On `isComplete`, show green checkmark and "Done" state
- [x] On `error` event, show red error state with the message

### 10. Update `AIBuilderClient.tsx` — build route SSE

- [x] Replace `await fetch('/api/pages/build', { method: 'POST', body: JSON.stringify({...}) }).then(r => r.json())` with `fetch(...)` then `readSSEStream(response, onEvent)`
- [x] Maintain local `events: SSEEvent[]` state, append each incoming event
- [x] Pass `events` and `isComplete` to `<LiveProgressPanel />` rendered in the build panel
- [x] On `{ type: "done" }` event, extract `html_url`, `slug`, `schema_json` from the event payload — same values as today's JSON response, same downstream logic
- [x] On `{ type: "error" }` event, show error toast / inline error message
- [x] Remove static `BUILD_STEPS` loading state array — replaced by live events

### 11. Update follow-up chat UI — follow-up route SSE

- [x] Replace `await fetch('/api/pages/[id]/follow-up', ...).then(r => r.json())` with `fetch(...)` then `readSSEStream(response, onEvent)`
- [x] While stream is open, render `<LiveProgressPanel events={events} isComplete={false} />` in the assistant chat bubble
- [x] On `{ type: "done" }`, replace `LiveProgressPanel` with the completed state (checkmark, "Page updated") and trigger page reload / iframe refresh with the new `html_url`
- [x] On `{ type: "error" }`, show error message in the chat bubble
- [x] `image_ready` thumbnails shown in `LiveProgressPanel` during generation — after done, they don't need to persist in chat history (the page itself has the images)

---

## Edge Cases & Guardrails ✅ Handled

- [x] **Claude skips `thinking` field** — regex won't match, no thinking event emitted. User just sees step messages. Graceful, no crash.
- [x] **Claude skips STATUS markers** — no `section_status` events emitted. User sees "Building HTML..." with no sub-steps. Graceful, no crash.
- [x] **STATUS comment inside `<style>` or `<script>`** — prevented by explicit prompt instruction. If it happens anyway, the strip regex removes it from HTML so it doesn't break CSS. The SSE extraction would still emit it as a section_status event (harmless).
- [x] **`thinking` regex matches across chunk boundary** — accumulate buffer before matching, never match against a single raw chunk which may be mid-token
- [x] **Image gen fails for one image** — `onImageReady` never called for that image, user sees fewer thumbnails than the count said. Already handled by existing try/catch in `generatePageImages()`.
- [x] **User closes tab mid-stream** — `request.signal.aborted` check between steps aborts early. Claude credits already spent for in-flight calls can't be recovered, but we stop before starting new ones.
- [x] **Network blip causes stream reader to retry** — frontend should NOT auto-retry SSE on failure (unlike `EventSource` which retries automatically). A retry would start a duplicate generation. On error, show message and let user manually resubmit.
- [x] **`maxDuration` not set** — silent 60s Vercel kill with no error event sent to client. Frontend hangs. This is why `maxDuration = 300` is a pre-implementation fix.

---

## Testing Checklist (manual — run in dev)

- [x] Build route — normal prompt: schema generated → images → HTML with STATUS markers → done event received
- [x] Build route — URL prompt: competitor scrape → schema → images → HTML → done
- [x] Follow-up — structural, normal prompt: thinking shown → images → STATUS markers → done
- [x] Follow-up — structural, URL prompt: fetch status → thinking → images → STATUS markers → done
- [x] Follow-up — style patch: thinking shown → done (no images, no STATUS markers)
- [x] Follow-up — error case (invalid prompt): error event shown in chat, no crash
- [x] Tab close mid-generation: verify backend aborts, no zombie Claude calls
- [x] Second structural follow-up on same page: existing `generated_image_url` fields not regenerated (guard still works)
- [x] Final HTML in Supabase: zero `<!-- STATUS: -->` comments present
- [x] No raw HTML/JSON/schema visible to user at any point in the UI
