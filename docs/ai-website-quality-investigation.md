# AI Website Generation — Quality Improvement Investigation

**Date:** 2026-06-25  
**Context:** Current AI builder generates functional but generic dark landing pages. This document investigates how to produce designer-quality output with real images, icons, animations, and a proper design system.

---

## Current State

### What we have

The generation pipeline has two Claude calls:

1. **`/api/pages/generate`** — Takes user prompt + vertical → returns a JSON schema (sections, copy, structure)
2. **`/api/pages/build`** — Takes that schema → returns complete self-contained HTML with inline CSS

### What the system prompt currently tells Claude to do

From `/api/pages/build/route.ts`:

```
- Dark, modern aesthetic with strong contrast
- System font stack, clear hierarchy
- CSS gradients as background fallbacks for null image fields
- Fully responsive, mobile-first
- Hero must be visually striking
- CTAs with hover states
```

### The problem

These instructions are too vague. "Dark, modern aesthetic" and "system font stack" give Claude almost no design constraints to work within. A designer doesn't think in those terms — they think in specific font families, exact spacing values, color tokens, component-level rules. Claude knows all of this, but only applies it when explicitly told.

The result: pages that are functional but look like boilerplate. No wow factor.

---

## Gap Analysis

### Gap 1 — No real images

**Current behavior:** Image fields in the schema are `null`. Claude falls back to CSS gradients (solid or two-color linear gradients).

**Impact:** Pages look unfinished. A real hero background or team photo immediately elevates perceived quality by 10x.

**Why Claude can't fix this alone:** Claude has no internet access. It cannot fetch or reference real image URLs. It can only work with what's injected into the schema before the build call.

**Solution:** Resolve images *before* calling `/api/pages/build`. After `/api/pages/generate` returns a schema, scan it for image fields (`hero.background_image`, `team.members[].photo`, etc.), derive search keywords from the vertical + headline text, call an image API, and inject real URLs into the schema. Claude then uses those URLs in `<img src="...">` tags.

**Recommended APIs:**
- **Pexels** (`https://api.pexels.com/v1/search?query=...`) — free tier, 200 req/hour, high quality stock photos, no attribution required in UI
- **Unsplash Source** (`https://source.unsplash.com/1600x900/?keyword`) — instant redirect to a random matching photo, no API key needed for basic use

**Implementation location:** New helper called between generate and build — either in the `AIBuilderClient.tsx` flow or a new `/api/pages/resolve-images` route.

---

### Gap 2 — No icons

**Current behavior:** No icon system referenced in the prompt or output. Benefits lists, feature bullets, and checkmarks are plain text.

**Impact:** Icons are one of the fastest visual upgrades. A checkmark icon next to a benefit line looks professional; plain text looks like a draft.

**Options:**

#### Option A — Lucide Icons via CDN (recommended)
Add one `<script>` tag to `<head>`:
```html
<script src="https://unpkg.com/lucide@latest"></script>
<script>document.addEventListener('DOMContentLoaded', () => lucide.createIcons());</script>
```
Then Claude can use `<i data-lucide="check-circle"></i>` anywhere. Claude knows Lucide's full icon set well.

- Pros: Minimal effort, Claude already knows the API, 1000+ icons available
- Cons: External CDN dependency — page breaks if unpkg is down

#### Option B — Inline SVGs
Tell Claude to write SVG markup directly for icons (checkmarks, arrows, stars, etc.).

- Pros: Truly self-contained, no external dependency
- Cons: Bloats HTML slightly, Claude must remember SVG paths

**Recommended:** Option A for speed of implementation, Option B if self-containment is a hard requirement (which it currently is — the build prompt says "no external stylesheets, no CDN links"). So **Option B** aligns with current architecture: tell Claude to write inline SVGs for common icons.

---

### Gap 3 — No animations

**Current behavior:** Static HTML. No transitions, no scroll effects, no micro-interactions.

**Impact:** Animations are the single biggest difference between a "built by a developer" page and a "built by a designer" page. Even a simple fade-in-on-scroll makes content feel purposeful.

**Options:**

#### Option A — Pure CSS animations
`@keyframes` + `animation` properties in `<style>`. Works for hero fade-ins, button pulses, etc. No JS needed.

#### Option B — Inline JS IntersectionObserver (recommended)
A small `<script>` block at the bottom of `<body>` that uses `IntersectionObserver` to add a CSS class when elements enter the viewport:

```js
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.1 });
document.querySelectorAll('.animate-on-scroll').forEach(el => observer.observe(el));
```

Claude adds `class="animate-on-scroll"` to section wrappers and defines `.animate-on-scroll` / `.visible` transitions in CSS. Result: smooth fade-up as user scrolls.

#### Option C — AOS library via CDN
`<link rel="stylesheet" href="https://unpkg.com/aos/dist/aos.css">` + `<script src="...aos.js">`. Then `data-aos="fade-up"` attributes. Very easy to prompt Claude to use.

- Cons: External CDN dependency.

**Recommended:** Option B — inline JS. Keeps pages self-contained, no CDN risk, Claude handles it well with clear instructions.

---

### Gap 4 — Weak design system in the prompt

This is the **highest-leverage change** with zero backend work. Everything below can be added to the `SYSTEM_PROMPT` in `/api/pages/build/route.ts`.

#### Typography
Current: `system font stack`  
Better: Specify a Google Font pair (or a high-quality system stack with explicit fallback chain). Example:
```
Typography:
- Load Inter (weights 400, 500, 700) and Syne (weight 700) from Google Fonts
- Headings: Syne Bold — H1: 72px/1.05, H2: 48px/1.1, H3: 32px/1.2
- Body: Inter Regular — 18px/1.7
- Subheads/labels: Inter Medium — 14px, 0.08em letter-spacing, uppercase
```

#### Color system
Current: `dark modern aesthetic`  
Better: Specify exact tokens with semantic meaning:
```
Color tokens:
- --bg-base: #080B14         (page background)
- --bg-surface: #0F1421      (cards, nav)
- --bg-elevated: #161D2E     (hover states, tooltips)
- --border: rgba(255,255,255,0.08)
- --text-primary: #F0F4FF
- --text-secondary: #8B9CC8
- --text-muted: #4A5578
- --accent: #3D8BDA          (primary CTA, links)
- --accent-hover: #5AA3F0
- --accent-glow: rgba(61,139,218,0.2)
- --success: #22C55E
- --gradient-hero: linear-gradient(135deg, #080B14 0%, #0D1829 50%, #080B14 100%)
```

#### Spacing system
Current: nothing specified  
Better:
```
Spacing: strict 8px grid
- Section vertical padding: 120px top/bottom (64px mobile)
- Container max-width: 1200px, horizontal padding: 24px
- Card padding: 32px
- Gap between grid items: 32px
- Stack gap (text blocks): 16px
```

#### Component rules
Current: nothing  
Better:
```
Cards:
- background: var(--bg-surface)
- border: 1px solid var(--border)
- border-radius: 16px
- box-shadow: 0 4px 24px rgba(0,0,0,0.3)
- On hover: border-color shifts to rgba(61,139,218,0.3), shadow brightens

Buttons (primary):
- background: var(--accent)
- border-radius: 10px
- padding: 14px 28px
- font: Inter 600, 16px
- On hover: background var(--accent-hover), translateY(-1px), box-shadow glow

Buttons (secondary/ghost):
- border: 1px solid var(--border)
- background: transparent
- On hover: border-color var(--accent), color var(--accent)
```

#### Visual hierarchy rules
```
- Only ONE primary CTA per section — never two equal-weight buttons side by side
- Section headlines: always centered, max-width 640px, margin auto
- Body text blocks: max-width 680px
- Feature grids: 3-column on desktop, 1-column on mobile
- Testimonial cards: 2-column on desktop
- Pricing tiers: highlight the middle tier with accent border + "Most Popular" badge
```

---

### Gap 5 — Per-vertical design differentiation

**Current behavior:** All verticals get the same dark theme regardless of the business type.

**Better approach:** Inject vertical-specific design hints alongside the schema. Examples:

| Vertical | Recommended palette shift | Tone |
|----------|--------------------------|------|
| `saas` | Blue-dominant accent (#3D8BDA), tech-forward | Professional, efficient |
| `local` | Warmer neutrals, softer gradients | Trustworthy, approachable |
| `legal` | Deep navy + gold accent, conservative spacing | Authoritative, credible |
| `ecommerce` | Higher contrast CTAs, more vibrant accent | Urgency, conversion |
| `lead_gen` | High-visibility form, minimal distractions | Focused, action-driven |

This can be implemented as a `VERTICAL_DESIGN_OVERRIDES` map in the build route, appended to the system prompt based on the schema's `vertical` field.

---

## Implementation Priority

| Change | File to modify | Effort | Expected impact |
|--------|---------------|--------|-----------------|
| Rewrite build system prompt with full design system (typography, colors, spacing, components) | `src/app/api/pages/build/route.ts` | 1–2 hours | Very High — immediate visual quality jump |
| Add inline SVG icons instruction to build prompt | `src/app/api/pages/build/route.ts` | 30 min | High |
| Add IntersectionObserver scroll animation instruction to build prompt | `src/app/api/pages/build/route.ts` | 30 min | High |
| Per-vertical design overrides in build prompt | `src/app/api/pages/build/route.ts` | 1 hour | Medium |
| Pexels/Unsplash image injection between generate and build | New `/api/pages/resolve-images` route + schema patch in builder | 3–4 hours | High |
| Increase `max_tokens` on build from 8192 to 16000 | `src/app/api/pages/build/route.ts` | 5 min | Medium — richer output, more complete pages |

**Recommended order:** Do prompt rewrites first (all in one file, zero risk), then image injection as a separate feature.

---

## What "Fine-Tuning" Actually Means Here

You cannot fine-tune Claude (Anthropic doesn't offer this via API). But that's not the bottleneck — Claude already has the design knowledge of a senior UI engineer. The gap is entirely in **how precisely we instruct it**.

Think of it like this: if you hired a world-class designer and gave them the brief "make something dark and modern," they'd still produce something mediocre because the brief is weak. Give the same designer a brand guide, a typography scale, a color system, and component rules — they produce something excellent.

That's exactly what a rewritten system prompt does. It's not training; it's briefing. And the briefing we currently have is thin.

---

## Key Files

- `src/app/api/pages/build/route.ts` — Build system prompt (main target)
- `src/app/api/pages/generate/route.ts` — Schema generation prompt
- `src/app/api/pages/[id]/follow-up/route.ts` — Follow-up edit prompt (should share design tokens with build prompt to stay consistent)



-- More Ideas:

Here is an actionable guide to optimizing your website generation results.1. Optimize Your Prompting StructureClaude performs significantly better when you separate style, layout, and functionality instead of asking for everything in one massive block of text.Provide a Component Design System: Don't just ask for a "modern dashboard." Define your design tokens in your system prompt. Pass a strict JSON object detailing your typography (e.g., Inter), color palette (e.g., Slate-900, Emerald-500), and border-radii.Use Visual Anchors: If your users can provide a layout structure, convert it into a simple text-based wireframe map (e.g., [Header] -> [Hero with 2 columns] -> [3-Card Feature Grid]) and pass that to the prompt.Enforce Component Isolation: Explicitly instruct Claude to build modular, pure components. Tell it to avoid hardcoded mock data deep inside visual elements; instead, instruct it to map over a clearly defined data array at the top of the file.2. Implement "Artifacts" or Clean Code IsolationIf you are querying the API, you need to prevent Claude from mixing conversational text ("Sure, here is your website!") with the actual code.Enforce XML Tags: Wrap your instructions so Claude returns code inside custom XML tags. For example, tell it: "Return the raw React component strictly inside <generated_code> tags." This allows your backend parser to easily extract and render the code.Utilize System Prompts for Refusal: Use a strict system prompt to stop conversational fluff: "You are an automated code generation API. Do not include introductory text, explanations, or conclusions. Output only valid code or structured JSON."3. Master the API ParametersHow you configure your API call dramatically changes Claude's creativity and deterministic coding accuracy.Lower the Temperature: For UI generation, a temperature of 0.1 to 0.3 is optimal. Higher temperatures cause Claude to hallucinate invalid Tailwind class names, forget to close tags, or invent non-existent library dependencies.Leverage Prompt Caching: Website generation often requires passing massive context (your design system, component libraries, or layout rules) over and over. Use Anthropic's Prompt Caching on your system instructions. This will reduce your API latency by up to 2x and slash your costs by up to 90%.4. Feed it a "Gold Standard" Reference (Few-Shot Prompting)Claude learns incredibly well by example. The absolute fastest way to improve quality is to provide a "Few-Shot" example in your prompt context.Show it exactly one masterfully designed page or component that you built manually.Structure it in the prompt as: "Here is an example of the code quality, Tailwind spacing, and semantic structure I expect from you:" followed by your reference code.Sonnet 4.6 will meticulously copy the spacing patterns, component breakdown, and responsive design choices of your example.5. Use an Iterative "Critic-Fixer" WorkflowSingle-turn generation often misses the mark on complex layouts. If you want production-ready sites, use a multi-step agentic approach:Generation Step: Claude Sonnet 4.6 generates the website code based on user prompt.Lint/Review Step: Pass the generated code to a separate, minor API call (or a code linter) with the prompt: "Review this code for missing closing tags, broken Tailwind classes, or overlapping absolute layouts. Output a list of issues."Refinement Step: Pass the original code and the issue list back to Claude Sonnet 4.6 to output the final, polished code.
