# Competitor URL Replication — Implementation Plan

## Goal
When a user pastes a competitor/reference URL in their prompt, SplitLab should automatically:
1. Scrape the site (Firecrawl) to extract real CSS tokens — colors, fonts, border radii, spacing
2. Screenshot the rendered page (ApiFlash) so Claude can see the visual layout
3. Pass both to Claude alongside the schema so the generated page closely matches the reference

This brings us to Lovable-level URL replication quality without requiring the user to manually take screenshots.

---

## Operation Sequencing — CRITICAL

Scraping **must complete before schema generation starts**. This is non-negotiable.

### Why schema cannot generate first

If schema generates without competitor context:
```
Competitor site: Nav → Hero → Logo strip → Features → Testimonials → Pricing → CTA → Footer (8 sections)

Schema Claude generates without context: Hero → Features → FAQ → CTA (4 sections, wrong structure)

Build step gets screenshot → sees 8 sections → conflicts with 4-section schema
→ Claude is confused, ignores half the context, output is wrong
```

The schema must reflect the competitor's section structure, count, and order — that only happens if Firecrawl results are passed into the generate call.

### Correct sequence for URL case

```
User prompt + URL detected
        ↓
Run Firecrawl + ApiFlash IN PARALLEL (~5-15s) via Promise.allSettled
        ↓
Wait for both to resolve (or timeout at 15s)
        ↓
Evaluate results — partial success is fine, proceed with whatever we got:

  Firecrawl ✓  ApiFlash ✓  → Full context. Best quality.
  Firecrawl ✓  ApiFlash ✗  → CSS tokens only. Claude gets exact values but no vision. Good quality.
  Firecrawl ✗  ApiFlash ✓  → Screenshot only. Claude sees the page but guesses values. Decent quality.
  Firecrawl ✗  ApiFlash ✗  → Both failed. Proceed as if no URL was given. Toast user. Normal quality.

Note: Promise.allSettled (NOT Promise.all) — one failure never cancels the other.
        ↓
Pass to Claude generate call:
  - user's original prompt
  - CSS token block (section order, colors, fonts) — only if Firecrawl succeeded
        ↓
Claude generates schema (~3-5s)
  → section count and order now matches competitor
  → section types match competitor
        ↓
Return to client: schema + screenshot_base64 + css_tokens
        ↓
Client calls /api/pages/build with all three
        ↓
Claude builds HTML:
  - screenshot passed as vision image block → Claude sees the page
  - css_tokens passed as :root guidance → Claude uses exact values
  - schema drives content and structure
```

### Screenshot is NOT passed to generate — only to build

Schema generation (generate route) does not need vision — it only needs section structure from Firecrawl tokens.
Screenshot is returned to the client alongside the schema and forwarded to the build call.
This avoids fetching the screenshot twice and keeps the generate call lean.

### Timing tradeoff

The URL case will be **~8-15 seconds slower** on the generate step. This is unavoidable and worth it — the scraping delay buys a correctly structured schema that the build step can actually match against the screenshot.

The UI loading state should reflect this with a new step:

```
"Fetching reference site…"   ← new, shown while Firecrawl + ApiFlash run
"Analyzing structure…"        ← schema generation
"Building structure…"
"Writing content…"
"Styling layout…"
"Saving page…"
```

---

## Why Two Services (Not Just One)

| Signal | Source | What Claude gets |
|---|---|---|
| Exact hex colors, font families, CSS variables | Firecrawl (HTML/CSS parse) | Concrete tokens to put in :root |
| Layout, card shapes, section order, spacing feel | Screenshot (vision) | Visual reference Claude can see |

Firecrawl alone → no visual. Screenshot alone → no exact values. Both together → Claude has everything.

---

## Services

| Role | Service | Free Tier | Env Var |
|---|---|---|---|
| Scraper | Firecrawl (firecrawl.dev) | 500 crawls/mo | `FIRECRAWL_API_KEY` |
| Screenshot | ApiFlash (apiflash.com) | 100 shots/mo | `APIFLASH_API_KEY` |

Both are simple REST APIs — one HTTP call each, no SDK required. Both work on Vercel serverless.

---

## Which APIs Use This

### `/api/pages/generate` — YES
- First place a URL appears
- Run Firecrawl + screenshot here in parallel
- Pass CSS token block into the schema generation prompt (screenshot is NOT passed here — only to build)
- Schema will reflect competitor section structure and tone
- Return `competitor_screenshot_base64` and `competitor_css_tokens` to client so they can be forwarded to build

### `/api/pages/build` — YES (receives context, does not re-fetch)
- Receives `competitor_screenshot_base64` + `competitor_css_tokens` from the client (forwarded from generate response)
- Passes screenshot as an image block to Claude vision
- Passes CSS token block as a structured note before the schema
- This is where the visual replication actually happens — Claude sees the page and has the tokens
- Design brief step also receives both to correctly classify style_tag
- **SYSTEM_PROMPT is conditional:**
  - No competitor context → use existing `SYSTEM_PROMPT` (infer palette from business type, choose layout from vertical)
  - Competitor context present → use `COMPETITOR_SYSTEM_PROMPT` (new) — same HTML rules but inference is replaced with "use EXACT values from tokens, match the screenshot"
  - `const systemPrompt = competitorContext ? COMPETITOR_SYSTEM_PROMPT : SYSTEM_PROMPT`
  - Both prompts share: data-field rules, TRACKER_PLACEHOLDER, nav rules, motion/scroll-reveal rules, fluid type scale, :root architecture — everything except the palette/layout inference section which is replaced in the competitor version

### `/api/pages/[id]/follow-up` — YES (re-fetches if URL in instruction)
- User may paste a URL mid-conversation: "make it look more like https://example.com"
- Detect URL in the follow-up instruction
- Run Firecrawl + screenshot again (new URL, new context)
- Inject both into the follow-up prompt
- **SYSTEM_PROMPT is conditional** — same logic as build: competitor context present → `COMPETITOR_SYSTEM_PROMPT`, else existing follow-up `SYSTEM_PROMPT`
- If no URL in instruction → normal follow-up flow, no fetch, existing SYSTEM_PROMPT

---

## New File to Create

`src/lib/ai-competitor-scrape.ts` — replaces current `ai-competitor-fetch.ts`

Exports:
- `extractUrls(text: string): string[]` — same as before
- `scrapeCompetitorUrl(url: string): Promise<CompetitorContext | null>`
  - Runs Firecrawl + ApiFlash in parallel
  - Returns `{ screenshotBase64: string, cssTokens: string } | null`
  - Returns null if both fail — caller falls back to normal flow silently

### CompetitorContext shape
```ts
interface CompetitorContext {
  screenshotBase64: string   // PNG as base64 — passed as image block to Claude
  cssTokens: string          // Structured text block with extracted design tokens
}
```

### cssTokens format (what Firecrawl extraction produces)
```
COLORS:
  Background: #0B1120
  Surface/card: #151F32
  Primary text: #F1F5F9
  Muted text: #94A3B8
  Accent/CTA: #3B82F6
  Accent hover: #2563EB

TYPOGRAPHY:
  Headline font: 'Inter', sans-serif — weight 700-800
  Body font: 'Inter', sans-serif — weight 400
  Letter spacing: tight on headings (-0.03em feel)

LAYOUT TOKENS:
  Card border radius: ~12px
  Section padding: large (~120px vertical)
  Border style: 1px solid rgba(255,255,255,0.08)
  Container max-width: ~1200px

SECTION ORDER:
  Nav → Hero (split two-column) → Logo strip → Features (alternating rows) → Testimonials → CTA → Footer
```

Claude extracts this from the Firecrawl HTML response using a short extraction prompt (separate mini Claude call, ~500 tokens).

---

## Todos

### Phase 1 — Setup & Extraction

- [ ] **Sign up for Firecrawl** — get API key, add `FIRECRAWL_API_KEY` to `.env.local` and Vercel env vars
- [ ] **Sign up for ApiFlash** — get API key, add `APIFLASH_API_KEY` to `.env.local` and Vercel env vars
- [ ] **Delete `src/lib/ai-competitor-fetch.ts`** — entire file removed, replaced by new scrape lib
- [ ] **Create `src/lib/ai-competitor-scrape.ts`**
  - `extractUrls()` — copy from old file, unchanged
  - `scrapeCompetitorUrl(url)` — runs Firecrawl + ApiFlash in parallel, returns CompetitorContext or null
  - Firecrawl call: `POST https://api.firecrawl.dev/v1/scrape` with `{ url, formats: ['rawHtml', 'html'] }`
    - `data.rawHtml` — unmodified HTML; regex-extract all `<style>...</style>` blocks from this for exact CSS tokens (colors, fonts, variables, border-radius)
    - `data.html` — Firecrawl's cleaned HTML (scripts/styles/head already stripped); use this for section order and DOM structure
    - Send both (extracted CSS blocks + cleaned HTML) to the mini extraction call — Claude gets exact token values from CSS AND correct section order from DOM
  - ApiFlash call: `GET https://api.apiflash.com/v1/urltoimage` with params `url`, `format=jpeg`, `quality=80`, `full_page=true`, `response_type=json`, `width=1280` — returns `{ url: "..." }`, fetch that URL and convert to base64. Full page JPEG at q80 keeps size safe (~300–600KB) while giving Claude the complete layout
  - Mini Claude call to extract CSS tokens — use `claude-sonnet-4-6`, ~500 tokens output, structured text format. Input: extracted `<style>` blocks from `rawHtml` + cleaned `html` for structure. If extraction call fails, treat as cssTokens = null and proceed with screenshot only
  - Both calls run in `Promise.allSettled` — partial success is fine (screenshot only, or tokens only)
  - Hard timeout: 15 seconds total — if either service hangs, resolve with what we have

### Phase 2 — Generate Route

- [ ] **Update `/api/pages/generate/route.ts`**
  - Remove old `extractUrls` + `fetchCompetitorContent` imports
  - Import `extractUrls`, `scrapeCompetitorUrl` from new lib
  - Detect URLs in prompt → call `scrapeCompetitorUrl`
  - Inject `cssTokens` as a structured note in the generate prompt (section structure + tone hint)
  - Return `competitor_screenshot_base64` and `competitor_css_tokens` in the JSON response
  - Screenshot NOT passed to generate's Claude call — schema generation doesn't need vision, build does
  - Remove old `competitor_context` and `competitor_fetch_failed` fields from response

### Phase 3 — Build Route

- [ ] **Update `/api/pages/build/route.ts`**
  - Accept `competitor_screenshot_base64` and `competitor_css_tokens` in request body
  - Pass screenshot as an image block to Claude (prepended to the user content array, same as chatImages)
  - Pass cssTokens as a structured note in textContent
  - **Use two separate SYSTEM_PROMPTs** — pick based on whether competitor context is present:
    - `SYSTEM_PROMPT` — existing prompt, used when no URL given. Rules: infer palette from business type, choose layout that fits the vertical.
    - `COMPETITOR_SYSTEM_PROMPT` — new prompt for URL builds. Same HTML rules (data-field, TRACKER_PLACEHOLDER, nav, motion, scroll-reveal, fluid type scale, :root architecture) but inference rules replaced with: "use EXACT hex codes and font families from the competitor token block — do not substitute. The screenshot is the visual truth — match section order, card styles, border radii, and spacing feel as closely as the schema allows."
    - Selection: `const systemPrompt = competitorContext ? COMPETITOR_SYSTEM_PROMPT : SYSTEM_PROMPT`
  - Pass `cssTokens` as the existing fourth arg `competitorContext` to `getDesignBrief(schema, userPrompt, imageUrls, cssTokens)` — no signature change needed, just pass cssTokens as the string. Screenshot is NOT passed into `getDesignBrief` — in the competitor flow the COMPETITOR_SYSTEM_PROMPT + screenshot in the main build call already handles visual matching, making the style exemplar secondary
  - Pass screenshot as image block to the main build Claude call with `media_type: 'image/jpeg'` (not image/png — must match the JPEG format requested from ApiFlash)
  - Remove old `competitor_context` handling

### Phase 4 — Follow-up Route

- [ ] **Update `/api/pages/[id]/follow-up/route.ts`**
  - Remove old `extractUrls` + `fetchCompetitorContent` imports
  - Import from new lib
  - Detect URL in instruction → call `scrapeCompetitorUrl`
  - Pass screenshot as image block + cssTokens as note in the follow-up prompt
  - Return `competitor_fetch_failed` only if URL was detected but both services failed
  - Remove old `competitor_context` handling

### Phase 5 — Client

- [ ] **Update `AIBuilderClient.tsx`**
  - Add two new state vars: `competitorScreenshot: string | null` and `competitorCssTokens: string | null` (replace old `competitorContext: string | null`)
  - `runGenerate`: read `competitor_screenshot_base64` + `competitor_css_tokens` from response — store in state vars **on BOTH branches** (questions branch AND schema branch). Currently the questions branch returns early before storing competitor context — this must be fixed: store the values before the early return so they survive the questions → schema round trip
  - `runBuild`: forward both in the build fetch body as `competitor_screenshot_base64` and `competitor_css_tokens`
  - Multiple URLs: `extractUrls()` may return more than one URL — **use only the first URL** for `scrapeCompetitorUrl`. First URL in the prompt is always the reference site.
  - Remove old `competitorContext` state and all `competitor_fetch_failed` toast references (replace with new ones)
  - URL indicator in prompt phase stays (Globe icon) — no change needed
  - Toast on failure: "Couldn't access that site — building from your description instead"
  - No toast on success — it just silently works

### Phase 6 — Cleanup

- [ ] Remove all references to old `competitor_context` / `competitor_fetch_failed` / `fetchCompetitorContent` / `extractUrls` from old lib across all files
- [ ] Verify `npm run build` passes with no type errors
- [ ] Test with a static site URL (e.g. a simple landing page) — should replicate closely
- [ ] Test with a JS-rendered site (e.g. devmoor.com) — Firecrawl renders JS so should still work

---

## Edge Cases

### Both services fail
- `scrapeCompetitorUrl` returns `null`
- Caller proceeds with normal generate/build flow — no competitor context
- Toast: "Couldn't access that site — building from your description instead"
- Page still generates, just without reference

### Firecrawl succeeds but mini CSS extraction call fails
- Firecrawl returned HTML but the `claude-sonnet-4-6` extraction call threw or returned garbage
- Treat same as Firecrawl fail — cssTokens = null, proceed with screenshot only (or null if ApiFlash also failed)
- Log the error but don't block the flow

### Firecrawl succeeds but ApiFlash fails (or vice versa)
- Partial context is still valuable — proceed with what we have
- cssTokens only → Claude has exact values but no visual → still much better than current
- Screenshot only → Claude sees the page but has to guess the values → decent quality
- Log which service failed but don't block the flow

### Multiple URLs in the prompt
- `extractUrls()` returns all URLs found in the prompt — user may paste two or more
- Use only the first URL for `scrapeCompetitorUrl` — first URL is always the reference site
- Ignore remaining URLs for competitor scraping (they may be docs links, image URLs, etc.)

### Questions round — competitor context must survive
- If generate returns `type: "questions"` (Claude needs clarification), `runGenerate` returns early
- Competitor context returned alongside the questions must be stored in state BEFORE the early return
- When user answers and `runGenerate` fires again, it calls `runBuild` with the stored context
- If not stored: URL builds that trigger a questions round lose all replication quality

### JS-heavy SPA (React/Next.js/Webflow)
- Firecrawl uses headless Chrome — renders JS before scraping
- Should work for most SPAs
- Some sites with aggressive bot detection (Cloudflare Turnstile, etc.) may still block
- ApiFlash also uses a real browser — same situation
- Fallback: proceed without competitor context

### Very large HTML response from Firecrawl
- `rawHtml` can be 500KB+ for complex pages — we never send it raw to Claude
- Regex-extract only `<style>...</style>` blocks from `rawHtml` (typically 10–50KB of pure CSS)
- Pair with `data.html` (cleaned DOM structure, no scripts/styles — much smaller) for section order
- Mini extraction call receives CSS blocks + cleaned HTML — complete signal, minimal token cost

### Competitor site with no external fonts (system fonts only)
- CSS token extraction will show `font-family: system-ui, -apple-system, sans-serif`
- Claude should match that — use Inter or similar neutral font
- Not a failure case, just a design signal

### Screenshot too large for Claude vision
- ApiFlash full-page PNG can be 10MB+ for tall pages — exceeds Claude's image size limits
- Fix: request `format=jpeg&quality=80` instead of PNG — a 1280×6000 JPEG at q80 is ~300–600KB, safely within limits
- Do NOT cap height or switch to viewport — full page is intentional so Claude sees every section

### Rate limiting — user generates many pages quickly
- Existing rate limiter covers the generate endpoint (3/min, 15/hr)
- Firecrawl + ApiFlash calls happen inside that same rate-limited request
- No additional rate limiting needed

### URL in follow-up references a completely different style
- User built a page for a law firm, then says "make it look like this fitness site (url)"
- Follow-up re-fetches the new URL and applies the new context as a style change
- The CSS tokens will override the original design — this is intentional

### Timeout on slow competitor sites
- Some sites take 5-10 seconds to render
- Firecrawl + ApiFlash both have their own timeouts
- We wrap the parallel call in a 15-second hard timeout using `Promise.race` with a timeout promise
- If timeout fires → return null → fall back to normal flow

---

## What Does NOT Change

- Schema generation logic — unchanged
- Design brief / style_tag classification — receives more context, same structure
- follow-up JSON output format — unchanged
- Conversation history storage — unchanged
- Image upload flow for user-attached images — completely separate, untouched
- Rate limiting — untouched
- TRACKER_PLACEHOLDER — untouched
- All existing prompt content in SYSTEM_PROMPT — additive only, no removals


URL:
https://api.apiflash.com/v1/urltoimage
?access_key=process.env.API_FLASH_KEY
&wait_until=page_loaded
&url=http://google.com

URL:
FIRECRAWL_API_KEY
Read: https://docs.firecrawl.dev/sdks/cli
Read: https://docs.firecrawl.dev/ai-onboarding