# AI Image Generation — Implementation Plan

## Flow

```
User prompt (URL or normal)
        ↓
[/api/pages/generate] Claude generates schema
  → Each section that needs an image gets: image_prompt + image_placement
  → Source of truth:
      URL prompt   → competitor HTML/screenshots tell Claude where images exist
      Normal prompt → Claude's knowledge of the vertical decides
        ↓
[/api/pages/build - new step] generatePageImages()
  → Extract all image_prompts from schema (section-level + item-level, max 8)
  → Call DALL-E 3 in parallel for each prompt
  → Fetch image buffer from OpenAI URL (expires ~1hr — must upload immediately)
  → Upload each to Supabase Storage via uploadImage()
  → Inject generated_image_url back into schema sections
        ↓
[/api/pages/build] Claude receives enriched schema
  → Sees generated_image_url + image_placement on each section
  → Uses real URLs in <img> tags or CSS background-image
        ↓
Final HTML with real AI-generated images
Enriched schema (with generated_image_url) saved to DB
```

.ENV variable: OPENAI_API_KEY

---

## Todos
- ✅ Done Comment OpenAI dead code ONLY openAI not anthropics
- ✅ Done Add image_prompt + image_placement rules to generate/route.ts system prompt — WHERE/WHAT rules for URL vs normal prompts, fixed image_placement vocabulary (background, right-column, left-column, full-width, card)
- ✅ Done Update schema section vocabulary (ai-page-vocabulary.ts) — add image_prompt and image_placement fields to relevant section types (hero, about, portfolio, team, testimonials)
- ✅ Done Wire dedicated OpenAI image client in ai-client.ts using OPENAI_API_KEY env var (separate from AI_API_KEY)
- ✅ Done Create generatePageImages() in ai-client.ts — extract all image_prompts from schema (section-level + item-level, max 8), call DALL-E 3 in parallel, fetch buffer from OpenAI URL (expires ~1hr), upload to Supabase via existing uploadImage(), return prompt→URL map
- ✅ Done Add graceful degradation to generatePageImages() — try/catch per image, skip failed ones (DALL-E rate limits / content policy), never fail the whole build over one image
- ✅ Done Wire image generation into build/route.ts — call generatePageImages() after schema ready, inject generated_image_url back into schema, save ENRICHED schema (with image URLs) to DB as schema_json
- ✅ Done Update build/route.ts system prompt — tell Claude to use generated_image_url in <img> tags or CSS background-image based on image_placement field
- ✅ Done Update AIBuilderClient.tsx loading state — add "Generating images..." phase message
- [ ] Test end-to-end — URL prompt and normal prompt, verify 1-8 images generated, uploaded to Supabase, URLs in final HTML, enriched schema saved to DB

---

## Follow-up Route — Image Generation (Option B)

### Flow
- Style/patch follow-up → unchanged (one Claude call, patch HTML, done)
- Structural follow-up → Pass 1 returns schema only → generatePageImages() → Pass 2 is full build pipeline (same as build/route.ts)

### Todos

**Shared function**
- ✅ Done Extract build HTML logic into shared function `buildHtmlFromSchema()` in `src/lib/ai-page-builder.ts` — takes (schema, options: { competitorScreenshots, competitorCssTokens, competitorPageContent, userPrompt, imageUrls, styleReferenceNote }) — NOTE: takes pre-formatted `styleReferenceNote` string, NOT raw HTML. Caller is responsible for formatting it. `generatePageImages()` is also called by the caller BEFORE this function — never inside it.
- ✅ Done Refactor build/route.ts to call `buildHtmlFromSchema()` — zero behavior change, just extracts the shared function. build/route.ts calls `generatePageImages()` first, then passes enriched schema to `buildHtmlFromSchema()`.

**Fix in generatePageImages()**
- ✅ Done Add guard to skip nodes that already have `generated_image_url` — `if (typeof o.image_prompt === 'string' && o.image_prompt && !o.generated_image_url)`. Without this, every structural follow-up regenerates ALL images including ones that already exist from the original build — wastes DALL-E credits.

**Follow-up system prompt**
- ✅ Done Modify follow-up system prompt — structural output shape: return `{ type, schema_json }` only (no html field). Style output shape: unchanged `{ type, html }`
- ✅ Done Add image_prompt + image_placement rules to follow-up system prompt — IMPORTANT: explicitly state "only add image_prompts to sections you are ADDING or structurally changing — never add image_prompts to existing sections the instruction does not touch." Without this, style/patch prompts ("make the hero darker") will trigger image_prompt generation on untouched sections, conflicting with the surgical change rule.

**Follow-up handler**
- ✅ Done Implement structural branch in follow-up handler:
  - Pass 1: Claude returns `{ type: "structural", schema_json }` — schema only, no HTML
  - `generatePageImages(parsed.schema_json, page.slug)` — generates images for new sections only (existing ones skipped by the guard above)
  - Caller formats `styleReferenceNote`: URL prompt → competitor CSS token block. Non-URL prompt → `"Maintain the exact visual style — colors, fonts, spacing — of this existing page: [minified old HTML]"`
  - Pass 2: `buildHtmlFromSchema(enrichedSchema, { styleReferenceNote, competitorScreenshots, ... })` — full build pipeline, HTML built once with real image URLs already in schema
- ✅ Done For non-URL structural: `styleReferenceNote` = `"Maintain the exact visual style of this existing page:\n[minifiedOldHtml]"` — skip design brief entirely. Old HTML already has `:root` CSS variables with all hex values Claude needs.
- ✅ Done For URL structural: competitor CSS tokens + screenshots passed directly to `buildHtmlFromSchema()` — `hasCompetitorContext` triggers COMPETITOR_SYSTEM_PROMPT automatically, no styleReferenceNote needed.
- ✅ Done Save ENRICHED schema (post `generatePageImages()`) to `conversation_json` history — NOT the raw Pass 1 schema. If pre-image schema is saved, future follow-ups will see `image_prompt` without `generated_image_url` and try to regenerate images that already exist in the HTML.
- ✅ Done Fix HTML validation in follow-up handler — structural: validate `parsed.schema_json` is an object (not `parsed.html`). Style: validate `parsed.html` starts with `<!DOCTYPE` (same as today).

**Tests**
- [ ] Test structural follow-up — normal prompt ("add a team section"), verify: image_prompts only on NEW sections, existing sections not regenerated, HTML rebuilt with real images, enriched schema saved to DB
- [ ] Test structural follow-up — URL prompt ("add their pricing section from https://..."), verify: competitor style preserved in rebuilt HTML, new section has DALL-E images
- [ ] Test style follow-up — verify unchanged path still works, no regressions
- [ ] Test second structural follow-up on same page — verify existing `generated_image_url` fields are preserved, not regenerated

---

## image_placement Vocabulary

| Value | Usage |
|---|---|
| `background` | CSS `background-image` on the section |
| `right-column` | `<img>` in a two-column layout, image on the right |
| `left-column` | `<img>` in a two-column layout, image on the left |
| `full-width` | Full-width `<img>` spanning the section |
| `card` | Per-item thumbnail inside a card grid (portfolio, team, testimonials) |

---

## image_prompt Rules

### WHERE to add image_prompt

| Section type | Rule |
|---|---|
| hero | Always — one image |
| about / team | Always — one image (team photo or founder portrait) |
| portfolio / work / projects | Always — one image_prompt PER item |
| testimonials | Always — one image_prompt per item (headshot) |
| gallery | Always — one image_prompt per item |
| features / services / cta | Add if visually common for the business type |
| nav / stats / pricing / faq / footer | Never |

### WHAT to write in image_prompt

**URL prompt** — read competitor HTML + screenshots:
- Identify type of image on that section (photo, illustration, screenshot)
- Match visual style from CSS tokens (dark/light, minimal/rich, corporate/playful)
- Example: `"professional dentist team photo, clinic setting, warm lighting, Canon DSLR quality, high resolution"`

**Normal prompt** — use vertical + business context:
- Pull specific details from the user's prompt (location, niche, product type)
- Match tone (luxury → "elegant, high-end", startup → "modern, minimal, bright")
- Be specific: ❌ "a team of people" ✅ "4-person fintech startup team, casual office, natural light, diverse"
- Always append: `", professional photography, high resolution"`

---

## Edge Cases

- **OpenAI URL expiry** — DALL-E 3 returns a hosted URL that expires in ~1hr. Must fetch the buffer and upload to Supabase before returning.
- **Graceful degradation** — try/catch per image. If one fails (rate limit, content policy), skip it and continue. Never fail the whole build.
- **Enriched schema saved to DB** — `schema_json` saved must be the version with `generated_image_url` injected, so follow-up conversations have the URLs.
- **Max 8 images** — cap to keep build time under ~20s of parallel DALL-E calls.
- **Plan gate** — image generation runs inside the existing Agency/Scale plan gate on the build route.
