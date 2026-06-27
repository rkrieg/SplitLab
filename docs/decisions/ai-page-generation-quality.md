# Decision: Improving AI Page Generation Quality

## Status
Implemented. Data layer (`src/lib/ai-page-vocabulary.ts`, `src/lib/ai-page-exemplars.ts`, `src/lib/ai-page-verticals.ts`) is wired into both `generate` and `build`. The design-brief step is a classification call inside `/api/pages/build` (`getDesignBrief()`), not a separate route — no frontend changes were needed.

## Problem
AI-generated pages (via `/api/pages/generate` + `/api/pages/build`) are too generic/basic. Root cause: a single LLM call jumps straight from JSON schema to full HTML/CSS with no design grounding, off a thin fixed library of ~7 section types. The `build` system prompt also hardcodes a vertical-agnostic design instruction ("dark, modern aesthetic") applied to every page regardless of business type — a SaaS page and a wedding photographer page currently get the same visual direction.

## What we decided to do
Decompose generation into three LLM calls instead of two, plus two small hardcoded lookup tables. No RAG, no vector DB, no embeddings.

1. **`generate`** (existing) — schema + content. Section vocabulary expanded from ~7 to 30 patterns in `src/lib/ai-page-vocabulary.ts` (comparison tables, stats bars, logo walls, problem/agitate/solve, before/after, process steps, urgency banners, e-commerce-specific patterns like product_showcase/reviews_ratings/shipping_trust, etc.), vertical-agnostic, all listed directly in the prompt. `VERTICAL_PRIORITY_HINTS` gives a short per-vertical bias (which patterns to favor) as a small hardcoded config object — not a knowledge base. Verticals expanded from 3 to 15 (`src/lib/ai-page-verticals.ts`), including an explicit `other` fallback with no bias — infer entirely from the prompt.

2. **Design brief (`getDesignBrief()` in `src/app/api/pages/build/route.ts`)** — a small Claude call (max_tokens 400) made inside `build`, before the main HTML generation call. Takes the schema + original user prompt + any attached chat images (vision blocks, same as the main build call) and outputs structured JSON: `{ style_tag, palette_direction, layout_rhythm, copy_tone, motion_style }`. `style_tag` is the LLM's own classification of the user's freeform words (e.g. "funky", "sleek", "corporate") into one of the fixed `StyleTag` values in `src/lib/ai-page-exemplars.ts` — this is where "the model interprets user wording" happens, not a search step. On any failure (bad JSON, unknown tag, network error) it returns `null` and the build proceeds without a style reference — this step must never block the actual page build.

3. **Code — plain dictionary lookup** — `STYLE_EXEMPLARS[style_tag]` against a hardcoded library (6 curated style exemplars: Minimal/Editorial, Bold/Maximalist, Corporate/Trust, Playful/Funky, Luxury/Premium, Technical/Dark — more can be added the same way). Returns 1 reference HTML/CSS snippet used purely for craft/taste calibration, not structural copying, appended to the main build call's user message as a "Style reference" block with an explicit instruction never to echo its literal text. Each exemplar is hero + one supporting section only, deliberately not a full page — see "Exemplars are not page templates" below.

4. **`build`** — receives schema + design brief + selected exemplar instead of generating blind off the schema alone. Also fixed the original root-cause bug here: the system prompt used to hardcode "Dark, modern aesthetic with strong contrast" for every page regardless of business — now it defers to the style reference instead.

## Exemplars are not page templates, and decorative content is not literal
Two clarifications that came up reviewing the exemplars, worth keeping explicit for whoever wires step 2/4:
- The exemplars are hero + one section only — they demonstrate per-section visual craft (palette, type, spacing, motion), not total page length or section count. The real page's actual section count/order comes from `schema_json` (built in step 1, can be 4-7+ sections). The build step must apply the demonstrated visual quality across *all* of the schema's sections, not just imitate the 2 sections shown.
- Any decorative content shown in an exemplar (e.g. `technical_dark`'s "React" / "AWS" floating-chip-style content, placeholder copy like "Atelier Studio") is a craft reference only. When generating a real page, decorative/proof-point content must be swapped for the real business's actual facts (stats, credentials, social proof) — never echoed verbatim from the exemplar.

## Motion — CSS-only by default, narrow exception for decorative JS
Settled while reviewing exemplar quality against real reference sites (see screenshots discussion):
- Default: CSS-only `@keyframes`/`transition` for all motion (entrance fades, hover states, continuous decorative loops like a floating shape or badge). No animation libraries, no external scripts — consistent with the `build` prompt's existing "no external stylesheets, no CDN links" rule.
- **Narrow exception, approved**: small, self-authored inline JS for purely decorative *state-cycling* (e.g. a rotating status line or mockup carousel) where CSS can't cleanly do it. Must follow all four guardrails, no exceptions:
  1. Wrapped in an IIFE (`(function(){ ... })();`) — same pattern already used for the contentEditable editor script in `AIBuilderClient.tsx`.
  2. **Every callback gets its own `try/catch`, not just the outer setup code.** A `try/catch` around the call to `setInterval()`/`setTimeout()` only catches synchronous errors during that call — it does NOT catch errors thrown later inside the callback itself, which runs in a new call stack. (Found this gap in our own first reference implementation — the outer-only try/catch in the initial `technical_dark` exemplar didn't actually protect the interval callback. Fixed by nesting a try/catch inside every callback, including nested `setTimeout`s.)
  3. May only animate/cycle purely decorative elements — never anything carrying `data-field` (editable schema content must always stay visible and clickable).
  4. Defensive null-checks before any DOM access (selectors may not match in every generated variant).
  - The `build`/`follow-up` system prompts give Claude a literal code skeleton to fill in for this, rather than just the rules above — concrete templates are followed far more reliably than abstract safety properties re-derived from scratch each time.
- **Hard rule, no exception**: Claude may only add JS it writes itself under the above guardrails. It must never add an external `<script src>` pointing to a third-party domain, and must never include JavaScript supplied verbatim by a user's prompt (tracking pixels, chat widget embeds, pasted snippets). Published pages share one domain (`trysplitlab.com/pages/[slug]`) across every tenant — unvetted third-party/user-supplied script is a shared reputational and security risk, and a direct risk to `tracker.js`/A-B test integrity. Legitimate script-injection needs should go through the existing workspace-level `scripts` feature, not a chat prompt.
- Reference implementation of the safe pattern: the rotating terminal status line in the `technical_dark` exemplar (`src/lib/ai-page-exemplars.ts`).

## What we decided NOT to do (and why)
- **No RAG / vector DB / embeddings.** RAG earns its cost when the candidate set is too large to fit in a prompt and/or is open-ended, unstructured, growing knowledge (e.g. retrieving from hundreds of real published pages by similarity, or grounding in a large compliance-doc corpus). Here the candidate sets are small and curated by hand (~20-30 section patterns, ~8-15 style exemplars) — small enough to hand the LLM the whole list directly. The "fuzzy matching" RAG would normally provide (interpreting freeform words like "funky") is instead done by the LLM itself in the design-brief step's classification output; code then does a plain lookup by the resulting tag, not a similarity search.
- **No self-critique/revision pass.** Roughly doubles cost and latency on the most expensive call, and a text-only critique pass can't actually see the rendered page — it's judging spacing/hierarchy from markup, not pixels. Deprioritized until quality from steps 1-3 is measured and still found lacking. If revisited, prefer a same-call checklist (no extra round trip) or a vision-based critique on an actual rendered screenshot over a second blind text pass.

## When RAG would become the right tool later
- Retrieving from SplitLab's own growing corpus of real published pages (by embedding similarity, possibly weighted by which ones converted well) — corpus grows continuously and isn't hand-curatable.
- Grounding vertical-specific copy in large unstructured reference material (e.g. jurisdiction-specific legal disclaimer language) that can't be reduced to a handful of tags.
- If style/vertical packs became something many outside contributors add to continuously rather than something the team curates directly.

None of these apply yet. Supabase already has `pgvector` available if/when this becomes necessary — no new infra would be needed to add it later.

## When to revisit
- After measuring output quality from the 3-call pipeline against the current 2-call baseline.
- When a 4th+ vertical is added — check whether the hardcoded per-vertical priority hints and exemplar tagging still scale cleanly as plain config, or start feeling unmanageable.
- If self-critique or real RAG retrieval (real-page grounding) becomes worth revisiting per the criteria above.
