# AI landing page design-quality — implementation plan

Two rules, that's it:

1. **User/PRD specifies something (colors, fonts, copy, layout) → follow it exactly.** No
   "improving," no substituting a similar font, no adjusting hex codes.
2. **User doesn't specify (a simple/vague prompt) → the AI designs a premium, distinctive,
   Lovable/Awwwards-competitive page on its own.** This is the part that needs work —
   today's default output is correct but generic.

Everything below is prompt-text added to `src/lib/ai-page-builder.ts`, sourced from
auditing `docs/skill-1/landing-page-design-main` (MIT) and the `creative-design` skills
in `docs/skill-1/claude-code-templates-main` (MIT root; `frontend-design` itself is
Apache-2.0, Anthropic's own official skill). Both scanned clean, safe to draw from.
Not adopting the Agent Skills beta API, not touching the React/Spline/Three.js material
(we output static HTML), not reintroducing few-shot exemplars (already rejected).

---

## Rule 1 — follow explicit specs (one small addition)

Add near the top of `SYSTEM_PROMPT` (`ai-page-builder.ts:44-46`):

```
## When the user/PRD specifies something, use it exactly
Exact hex codes, named fonts, verbatim copy, explicit layout instructions in the
"Original user request" or schema are never overridden, adjusted, "improved," or
reworded — copy them exactly. Only invent/design what they left unspecified.
```

This also clarifies the existing competitor-token-block rule (`ai-page-builder.ts:440-445`,
untouched) as the same principle applied to competitor references.

---

## Rule 2 — no spec given, make it premium (the real work)

Applies only when Rule 1 finds nothing explicit to follow. Six additions, all inside
`SYSTEM_PROMPT` / `DESIGN_BRIEF_SYSTEM_PROMPT`, no new AI calls, no cost growth:

**Typography** (`ai-page-builder.ts:59-69`) — blacklist the generic-AI defaults as
primary display font: Inter, Roboto, Open Sans, Poppins, Montserrat, Raleway, Arial.
Pair a characterful display font with a neutral body font — not two similar sans-serifs.
Mix weights dramatically (700-900 headline next to 300-400 body).

**Color** (`ai-page-builder.ts:203-214`) — one dominant hue used with intention beats an
evenly-distributed palette. Off-whites/warm-or-cool-tinted near-blacks instead of flat
neutral gray, matched to the brand mood.

**Emphasis shadows** (`ai-page-builder.ts:141-149`, `182-190`) — highest-confidence fix,
directly evidenced by the earlier diff against Lovable's output: every card currently
gets the same flat gray shadow, and pricing/comparison sections style both options
identically even when one should read as better.
```
When a section presents options where one should read as better (pricing tiers,
comparison columns, "us vs. them"), mark the favored option: border: 1-2px solid
var(--accent), stronger box-shadow (0 12px 32px var(--accent-glow) vs. the flat
--shadow), optionally translateY(-8px) or a badge. Never style unequal options equally.
```

**Nav variety** (`ai-page-builder.ts:236-299`) — currently always converges on
logo-left/links-center/CTA-right. Add alternatives to pick from by business type:
inline centered wordmark with tabs below, marquee/ticker strip for lead-gen pages,
left-vertical nav for editorial/portfolio pages. Keep existing sticky/drawer/hamburger
mechanics as-is.

**Micro-details** (`ai-page-builder.ts:226-234`) — `::selection` styled to the accent
color instead of browser default blue, custom `::-webkit-scrollbar` matching page
tokens, optional subtle grain/noise texture on hero/dark sections (CSS/SVG only).

**Vibe synthesis** (`DESIGN_BRIEF_SYSTEM_PROMPT`, `ai-page-builder.ts:16-22`) — the
client's core complaint is every generated page looking the same. Add two fields to the
design-brief JSON, used only when Rule 1 found nothing explicit:
```
"reference_object": "one real-world place or object this brand's energy maps to — specific, not a category",
"wildcard_element": "one specific visual/interaction detail that makes the page memorable"
```
Folded into the existing style-reference note (`ai-page-builder.ts:610-616`) — no growth
to the Opus system prompt. This lives inside `getDesignBrief()`, which the follow-up
route already bypasses (`ai-page-builder.ts:601`), so it's build-only by construction.

---

## Rollout

1. Rule 1 + the five static Rule-2 additions (typography, color, shadows, nav,
   micro-details) together — pure additive text, verify with `npm run build`.
2. Generate a handful of pages: one with a detailed PRD (should reproduce it exactly),
   a few with vague prompts (should look distinctly better — check shadows/hierarchy
   specifically, that's the most directly evidenced gap from the Lovable diff).
3. Vibe synthesis last, tested only on the vague-prompt cases.
