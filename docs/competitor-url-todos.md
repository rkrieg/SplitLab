# Competitor URL Replication — Full TODO List

Complete implementation checklist. Work top to bottom — each phase depends on the previous.

---

## Phase 1 — Environment Setup

- [ ] Sign up at firecrawl.dev → get `FIRECRAWL_API_KEY` ✅DONE
- [ ] Sign up at apiflash.com → get `APIFLASH_API_KEY`  ✅DONE
- [ ] Add both to `.env.local` ✅DONE
- [ ] Add both to Vercel environment variables (Production + Preview) 

---

## Phase 2 — New Scrape Library

**Delete:** `src/lib/ai-competitor-fetch.ts` — entire file gone ✅DONE

**Create:** `src/lib/ai-competitor-scrape.ts` ✅DONE

- [ ] Define `CompetitorContext` interface:
  ```ts
  interface CompetitorContext {
    screenshotBase64: string  // JPEG as base64
    cssTokens: string         // structured design token block
  }
  ``` ✅DONE

- [ ] Export `extractUrls(text: string): string[]` ✅DONE
  - Copy regex from old file — unchanged
  - `text.match(/https?:\/\/[^\s"'<>)]+/gi) ?? []` deduplicated ✅DONE

- [ ] Export `scrapeCompetitorUrl(url: string): Promise<CompetitorContext | null>` ✅DONE

  **Firecrawl call:**
  - ✅DONE `POST https://api.firecrawl.dev/v1/scrape`
  - ✅DONE Body: `{ url, formats: ['rawHtml', 'html'] }`
  - ✅DONE Auth: `Authorization: Bearer ${FIRECRAWL_API_KEY}`
  - ✅DONE From response: use `data.rawHtml` for CSS extraction, `data.html` for section structure

  **CSS extraction from rawHtml:**
  - ✅DONE Regex-extract all `<style>...</style>` blocks from `data.rawHtml`
  - ✅DONE Combine extracted CSS blocks into one string
  - ✅DONE Do NOT send raw full HTML to Claude — only the extracted CSS blocks + `data.html`

  **Mini Claude call (CSS token extraction):**
  - ✅DONE Model: `claude-sonnet-4-6`
  - ✅DONE Max tokens: ~600
  - ✅DONE Input: extracted `<style>` blocks + `data.html` (cleaned DOM for section order)
  - ✅DONE Prompt: extract structured token block in this format:
    ```
    COLORS:
      Background: #...
      Surface/card: #...
      Primary text: #...
      Muted text: #...
      Accent/CTA: #...

    TYPOGRAPHY:
      Headline font: '...' — weight ...
      Body font: '...' — weight ...

    LAYOUT TOKENS:
      Card border radius: ...
      Section padding: ...
      Border style: ...
      Container max-width: ...

    SECTION ORDER:
      Nav → Hero → ... → Footer
    ```
  - ✅DONE If this call throws or returns garbage → cssTokens = null, continue with screenshot only

  **ApiFlash call:**
  - ✅DONE `GET https://api.apiflash.com/v1/urltoimage`
  - ✅DONE Params: `access_key`, `url`, `format=jpeg`, `quality=80`, `full_page=true`, `response_type=json`, `width=1280`, `wait_until=page_loaded`
  - ✅DONE Response: `{ url: "https://..." }` — fetch that URL, convert response to base64
  - ✅DONE media_type is `image/jpeg` — noted, enforced in build step

  **Parallel execution:**
  - ✅DONE Run Firecrawl + ApiFlash via `Promise.allSettled` — one failure never cancels the other
  - ✅DONE Wrap in 15-second hard timeout via `Promise.race` with a timeout promise
  - ✅DONE Evaluate results:
    - Both succeed → return `{ screenshotBase64, cssTokens }`
    - Firecrawl only → return `{ screenshotBase64: '', cssTokens }`
    - ApiFlash only → return `{ screenshotBase64, cssTokens: '' }`
    - Both fail → return `null`
  - ✅DONE Log which service failed — never throw, always return null on total failure

---

## Phase 3 — Generate Route ✅DONE

**File:** `src/app/api/pages/generate/route.ts`

- ✅DONE Remove import: `extractUrls, fetchCompetitorContent` from `@/lib/ai-competitor-fetch`
- ✅DONE Add import: `extractUrls, scrapeCompetitorUrl` from `@/lib/ai-competitor-scrape`
- ✅DONE Extract URLs from prompt using `extractUrls(prompt)`
- ✅DONE If URLs found → use **first URL only** → call `scrapeCompetitorUrl(urls[0])`
- ✅DONE Await scrape result BEFORE calling Claude for schema (sequencing is non-negotiable)
- ✅DONE If cssTokens present → inject into schema generation prompt as a structured note:
  ```
  ## Reference site context
  The user referenced: <url>
  Use this section structure and tone as the basis for the schema:
  <cssTokens>
  Match the section count, order, and types from SECTION ORDER above.
  ```
- ✅DONE Screenshot is NOT passed to generate's Claude call — schema doesn't need vision
- ✅DONE Return in JSON response:
  - `competitor_screenshot_base64: string | undefined`
  - `competitor_css_tokens: string | undefined`
- ✅DONE Remove old fields from response: `competitor_context`, `competitor_fetch_failed`

---

## Phase 4 — Build Route ✅DONE

**File:** `src/app/api/pages/build/route.ts`

- ✅DONE Accept in request body: `competitor_screenshot_base64?: string`, `competitor_css_tokens?: string`
- ✅DONE Determine `hasCompetitorContext` = screenshot or tokens present

**COMPETITOR_SYSTEM_PROMPT (new constant):**
- ✅DONE `COMPETITOR_SYSTEM_PROMPT` = `SYSTEM_PROMPT` + override section appended at the end (all shared rules identical, override wins by appearing last):
  ```
  ## Competitor reference — EXACT replication rules (OVERRIDES all palette and style inference above)
  - Use EXACT hex codes from token block
  - Use EXACT font families from token block
  - Screenshot is visual truth — match section order, card shapes, border radii, spacing feel
  - Do not default to generic dark/light — replicate what you see
  ```
- ✅DONE Keep identical: data-field rules, TRACKER_PLACEHOLDER, nav rules, motion/scroll-reveal, fluid type scale, :root architecture (shared via SYSTEM_PROMPT base)
- ✅DONE Extended `AIContentBlock` in `ai-client.ts` to support `{ type: 'image_base64', data, mediaType }` — Anthropic adapter maps to base64 source, OpenAI adapter maps to data URI

**Conditional system prompt:**
- ✅DONE `const systemPrompt = hasCompetitorContext ? COMPETITOR_SYSTEM_PROMPT : SYSTEM_PROMPT`

**Screenshot as image block:**
- ✅DONE Competitor screenshot prepended to user content array as `{ type: 'image_base64', data: competitor_screenshot_base64, mediaType: 'image/jpeg' }`
- ✅DONE `mediaType: 'image/jpeg'` — matches JPEG format from ApiFlash

**CSS tokens as text note:**
- ✅DONE `competitorTokenNote` prepended to textContent: `## Competitor CSS token block — use these EXACT values\n${competitor_css_tokens}`

**Design brief:**
- ✅DONE `competitor_css_tokens` passed as existing fourth arg to `getDesignBrief` — no signature change
- ✅DONE Screenshot does NOT go into `getDesignBrief` — only the main build call gets the image block

- ✅DONE Removed old `competitor_context` handling

---

## Phase 5 — Follow-up Route ✅DONE

**File:** `src/app/api/pages/[id]/follow-up/route.ts`

- ✅DONE Remove import: `extractUrls, fetchCompetitorContent` from `@/lib/ai-competitor-fetch`
- ✅DONE Add import: `extractUrls, scrapeCompetitorUrl` from `@/lib/ai-competitor-scrape`
- ✅DONE Detect URLs in follow-up instruction using `extractUrls(prompt)`
- ✅DONE If URL found → use first URL only → call `scrapeCompetitorUrl(mentionedUrls[0])`
- ✅DONE If scrape succeeds → inject into follow-up prompt:
  - Screenshot prepended as `{ type: 'image_base64', data, mediaType: 'image/jpeg' }` block
  - cssTokens prepended as `competitorTokenNote` in textContent
- ✅DONE `COMPETITOR_SYSTEM_PROMPT` defined locally as follow-up `SYSTEM_PROMPT` + override section (same override text as build route, different base since follow-up has a different SYSTEM_PROMPT)
- ✅DONE `const systemPrompt = hasCompetitorContext ? COMPETITOR_SYSTEM_PROMPT : SYSTEM_PROMPT`
- ✅DONE `competitor_fetch_failed: true` set in response when URL detected but both services failed
- ✅DONE No URL in instruction → competitorContext null → existing SYSTEM_PROMPT used, no fetch
- ✅DONE Old `competitor_context` string handling removed

---

## Phase 6 — Client ✅DONE

**File:** `src/app/(dashboard)/clients/[id]/pages/new/AIBuilderClient.tsx`

**State:**
- ✅DONE Removed: `const [competitorContext, setCompetitorContext] = useState<string | null>(null)`
- ✅DONE Added: `const [competitorScreenshot, setCompetitorScreenshot] = useState<string | null>(null)`
- ✅DONE Added: `const [competitorCssTokens, setCompetitorCssTokens] = useState<string | null>(null)`

**`runGenerate` — store context on BOTH branches:**
- ✅DONE Stores screenshot + tokens immediately after `res.json()`, before any branch
- ✅DONE Happens BEFORE the `if (data.type === 'questions')` early exit — survives questions round trip
- ✅DONE Removed old `if (data.competitor_context) setCompetitorContext(...)` handling

**`runGenerate` — toasts:**
- ✅DONE Removed old `competitor_fetch_failed` toast from generate (server no longer returns that field)
- ✅DONE No success toast — silent on success

**`runBuild` — forward context:**
- ✅DONE Removed `passedCompetitorContext` param — reads from state instead
- ✅DONE Forwards `competitor_screenshot_base64` and `competitor_css_tokens` from state in build fetch body
- ✅DONE Removed old `competitor_context` from build fetch body

**Multiple URLs:**
- ✅DONE No client change needed — first-URL-only enforced server-side in generate route

**Loading steps:**
- ✅DONE "Fetching reference site…" shown during generating phase when URL detected in prompt (client-side regex `/https?:\/\/[^\s]+/i.test(prompt)`)

**Follow-up toast:**
- ✅DONE Updated toast: "Couldn't access that site — building from your description instead."
- ✅DONE Old `competitor_fetch_failed` toast replaced

---

## Phase 7 — Cleanup ✅DONE

- ✅DONE `competitor_context` — zero remaining references in codebase
- ✅DONE `competitor_fetch_failed` — two remaining references are INTENTIONAL (follow-up route sets it on scrape failure; client reads it to show toast). Not dead code.
- ✅DONE `fetchCompetitorContent` — zero remaining references
- ✅DONE `from '@/lib/ai-competitor-fetch'` — zero imports remain
- ✅DONE `src/lib/ai-competitor-fetch.ts` — confirmed deleted
- ✅DONE `npm run build` — passes with zero type errors and zero warnings
- ✅DONE `npm run lint` — ESLint not configured in this project (no .eslintrc); build type-check is the equivalent gate and passes clean

---

## Phase 8 — Testing

- [ ] Test: static site URL (e.g. a simple HTML landing page) — Firecrawl + ApiFlash both work, colors/fonts/sections match
- [ ] Test: JS-rendered site (e.g. devmoor.com) — Firecrawl renders JS, output is close to source
- [ ] Test: URL that returns questions round — competitor context survives, still applied at build step
- [ ] Test: URL in follow-up instruction ("make it look like https://...") — re-fetches, applies new style
- [ ] Test: unreachable URL (e.g. localhost, private site) — graceful fallback, toast shown, page still generates
- [ ] Test: no URL in prompt — existing flow completely unchanged, `SYSTEM_PROMPT` used (not COMPETITOR_SYSTEM_PROMPT)
- [ ] Test: multiple URLs in one prompt — only first URL scraped, page still generates correctly
- [ ] Test: Firecrawl succeeds but ApiFlash fails — cssTokens-only path, still better than before
- [ ] Test: ApiFlash succeeds but Firecrawl fails — screenshot-only path, visual match partial
- [ ] Verify `npm run build` still passes after all changes


Issues:
input=67299 on the mini CSS call = 67K tokens just for CSS extraction = extremely expensive (~$0.20 per call). Need to truncate CSS before that call. Colors — likely the CSS token mini call is correct but the huge 67K input is overwhelming it. Real fix later, for now strengthen the instruction

