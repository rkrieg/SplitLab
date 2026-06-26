# Decision: Improving AI Page Generation Quality

## Status
Decided — not yet implemented.

## Problem
AI-generated pages (via `/api/pages/generate` + `/api/pages/build`) are too generic/basic. Root cause: a single LLM call jumps straight from JSON schema to full HTML/CSS with no design grounding, off a thin fixed library of ~7 section types. The `build` system prompt also hardcodes a vertical-agnostic design instruction ("dark, modern aesthetic") applied to every page regardless of business type — a SaaS page and a wedding photographer page currently get the same visual direction.

## What we decided to do
Decompose generation into three LLM calls instead of two, plus two small hardcoded lookup tables. No RAG, no vector DB, no embeddings.

1. **`generate`** (existing) — schema + content. Expand the system prompt's section vocabulary from ~7 to ~20-30 patterns (comparison tables, stats bars, logo walls, problem/agitate/solve, before/after, process steps, urgency banners, sticky CTA, etc.), vertical-agnostic, all listed directly in the prompt. Add a short per-vertical priority hint (which patterns to favor) as a small hardcoded config object — not a knowledge base.

2. **Design brief (new step)** — inserted between `generate` and `build`. Takes the prompt + vertical + schema, outputs structured JSON: `{ style_tag, palette_direction, layout_rhythm, copy_tone }`. `style_tag` is the LLM's own classification of the user's freeform words (e.g. "funky", "sleek", "corporate") into one of a fixed known set — this is where "the model interprets user wording" happens, not a search step.

3. **Code — plain dictionary lookup** — `exemplars[style_tag]` against a small hardcoded library (~8-15 curated style exemplars: Minimal/Editorial, Bold/Maximalist, Corporate, Playful, Luxury, Technical/Dark, Warm/Organic, Clean SaaS). Returns 1-2 reference HTML/CSS snippets used purely for craft/taste calibration, not structural copying.

4. **`build`** (existing) — now receives schema + design brief + selected exemplars instead of generating blind off the schema alone.

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
