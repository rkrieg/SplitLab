# Token Reduction — Patch-Based Follow-Up

## Architecture Decision Log

### React vs Flat HTML — Decision: Stay with Flat HTML

**Considered:** Switching to React components for Lovable-style surgical edits (isolated component files, instant class swaps).

**Rejected because:**
- The serve route (`src/app/api/serve/route.ts`) works by fetching a flat HTML file and injecting tracking scripts via `injectIntoHtml()`. React apps cannot be injected into — this breaks A/B test tracking entirely.
- React pages require a build step + deployment pipeline per page per client. Completely different infrastructure.
- Users can currently download a clean `.html` file that works anywhere. React would tie them to our hosting forever.
- If we host React pages and they use the URL as a redirect variant, tracking injection breaks and they're dependent on our uptime.

**Conclusion:** Flat HTML is the correct architecture for a landing page A/B testing product. The serve/track/inject pipeline is built around it and must stay that way.

---

### Section-Level vs Sub-Section Markers — Decision: Start with Section-Level

**Considered:** Adding sub-section markers inside sections (e.g. `<!-- SL:hero-headline -->`, `<!-- SL:hero-cta -->`) for even more surgical patches.

**Rejected for now because:**
- Section-level patches already reduce output tokens from ~12,000 → ~800 per edit
- Time improvement: 30-45s → 6-8s per small change — already a major win
- Sub-section markers add significant complexity to both generation and parsing
- We don't know yet which sub-elements users edit most frequently

**Decision:** Ship section-level markers first. Add sub-section markers later only if real users report 6-8s still feels slow for specific edit types (headline, CTA button, stats row are the likely candidates).

---

### CSS Variables vs Tailwind — Decision: Keep Custom CSS

**Confirmed from code (`src/lib/ai-page-builder.ts` line 46):** System prompt explicitly says `no Bootstrap, no Tailwind CDN`. Claude generates pure custom CSS with `:root` CSS variables.

**This is actually better for patching:** Color changes only touch `--accent`, `--bg` etc in the `<!-- SL:head -->` block. One variable change cascades everywhere on the page automatically. No need to find and replace class names across multiple sections.

---

## Goal

Reduce follow-up API response time for small changes from ~30-45s → ~5-10s.

**How:** Full HTML in → Claude returns only changed snippet(s) → splice back into stored HTML on our end.

| | Current | New |
|---|---|---|
| Input tokens | ~15K | ~15K (same) |
| Output tokens | ~15K | ~500-1.5K |
| Time | 30-45s | 5-10s |

Output is where the time is spent — Claude writes token by token. 10x less output = dramatically faster.

---

## How It Works

### Section Markers (injected at build time)

Every section in the built HTML gets wrapped with named comment markers:

```html
<!-- SL:head -->
<style>:root { --brand-color: #ff0000; }</style>
<!-- /SL:head -->

<!-- SL:hero -->
<section class="hero">...</section>
<!-- /SL:hero -->

<!-- SL:faq -->
<section class="faq">...</section>
<!-- /SL:faq -->
```

- Section names come from schema (available at build time)
- `SL:head` wraps the `<style>` block — covers CSS variable / color changes
- Invisible to end users
- Survive Supabase storage/retrieval unchanged

---

### Claude Response Format

**Single patch:**
```
TYPE:PATCH
SECTION:hero
<section class="hero">...updated...</section>
```

**Multiple patches (up to 3):**
```
TYPE:PATCH
SECTION:hero
<section class="hero">...updated...</section>
SECTION:pricing
<section class="pricing">...updated...</section>
```

**New section inserted:**
```
TYPE:PATCH
ACTION:INSERT AFTER:hero
SECTION:testimonials
<section class="testimonials">...new section...</section>
```

**Section deleted:**
```
TYPE:PATCH
ACTION:DELETE SECTION:faq
```

**Full rebuild (Claude decides):**
```
TYPE:REBUILD
<!DOCTYPE html>...full HTML...
```

---

### System Prompt Rules for Claude

> - Analyze the follow-up request against the current page HTML.
> - If the change is localized (color, text, content, style tweak, add/remove/reorder a section), respond with TYPE:PATCH.
> - For PATCH: return only the changed section(s) using the exact SECTION name from the <!-- SL:name --> markers.
> - If the change touches more than 3 sections, respond with TYPE:REBUILD and return the full HTML.
> - If the user references a new URL, respond with TYPE:REBUILD.
> - For adding a new section: use ACTION:INSERT AFTER:<section-name> to specify placement.
> - For removing a section: use ACTION:DELETE SECTION:<section-name>.
> - For color/style changes: patch the SL:head section (CSS variables) rather than individual sections where possible.
> - Return the section HTML with ONLY the requested change. Every other attribute, class, style, and element must be identical to the input.

---

## Implementation Todos

- [ ] **Step 1 — Inject section markers at build time**
  - In `src/lib/ai-page-builder.ts`, after HTML is generated, post-process to wrap each top-level section with `<!-- SL:name -->...<!-- /SL:name -->` using schema section names
  - Wrap `<style>` block in `<head>` with `<!-- SL:head -->...<!-- /SL:head -->`
  - Deduplicate section names with suffix (`features-1`, `features-2`) to avoid duplicate markers

- [ ] **Step 2 — Update follow-up system prompt**
  - Add patch/rebuild instructions to system prompt in `src/app/api/pages/[id]/follow-up/route.ts`
  - Include TYPE:PATCH, TYPE:REBUILD, ACTION:INSERT, ACTION:DELETE format rules

- [ ] **Step 3 — URL detection → always full rebuild**
  - In follow-up route, check `if (/https?:\/\//.test(prompt))` before calling Claude
  - If true → skip patch prompt → run existing full rebuild flow unchanged

- [ ] **Step 4 — Parse Claude response and route accordingly**
  - Detect `TYPE:PATCH` or `TYPE:REBUILD` from first line of response
  - `TYPE:REBUILD` → upload full HTML directly (existing flow)
  - `TYPE:PATCH` → pass to `applyPatch()`

- [ ] **Step 5 — Implement `applyPatch()`**
  - Parse all `SECTION:name` blocks from response
  - For each: regex-replace `<!-- SL:name -->...<!-- /SL:name -->` in stored HTML
  - Handle `ACTION:INSERT AFTER:name` → find `<!-- /SL:name -->`, insert new section block after it (wrapped in new markers)
  - Handle `ACTION:DELETE SECTION:name` → remove entire `<!-- SL:name -->...<!-- /SL:name -->` block
  - If more than 3 sections in patch → treat as rebuild (safeguard)

- [ ] **Step 6 — Image detection in patches**
  - Before splicing, check if patch HTML contains `image_prompt` or placeholder image
  - If yes → generate image via DALL-E first → inject URL → then splice
  - File: `src/app/api/pages/[id]/follow-up/route.ts`

- [ ] **Step 7 — SSE status messages for patch flow**
  - `"Analyzing changes..."` — while Claude processes
  - `"Applying patch..."` — while splicing and uploading
  - `"done"` — with updated `html_url`
  - Full rebuild keeps existing status messages unchanged

---

## Edge Cases & Solutions

| Scenario | Solution |
|---|---|
| Claude returns full HTML despite patch instruction | First line check: if `<!DOCTYPE` or `<html` → upload directly as full HTML, skip splice |
| CSS/color change (lives in `<head>`) | `<!-- SL:head -->` marker wraps `<style>` block — Claude patches CSS variables there |
| More than 3 sections need patching | Claude instructed to return `TYPE:REBUILD` instead; our code also enforces this as a safeguard |
| New section added (no existing marker) | `ACTION:INSERT AFTER:name` — splice after closing marker of named section |
| Section deleted | `ACTION:DELETE SECTION:name` — remove entire marked block |
| Image needed in patched section | Detect image placeholder in patch → generate image → inject URL → then splice |
| Old pages without markers | No markers found → automatically fall back to full HTML rewrite |
| Duplicate section names in schema | Suffix at build time: `features-1`, `features-2` |
| Drift within snippet | System prompt: "every other attribute, class, style must be byte-identical to input" |

---

## Files to Change

| File | Change |
|---|---|
| `src/lib/ai-page-builder.ts` | Inject `<!-- SL:name -->` markers + `<!-- SL:head -->` after build |
| `src/app/api/pages/[id]/follow-up/route.ts` | URL check, patch system prompt, response parser, `applyPatch()`, SSE status msgs |

## Files NOT to Change

| File | Reason |
|---|---|
| `src/lib/sse.ts` | No changes needed |
| `src/lib/ai-client.ts` | No changes needed |
| `src/components/ai/LiveProgressPanel.tsx` | Already handles status/done events |
| `src/app/api/pages/build/route.ts` | Markers added in ai-page-builder, not here |
