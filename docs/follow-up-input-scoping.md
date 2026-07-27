# Follow-Up Input Scoping — Two-Pass Patch (Router + Scoped Generation)

## Status
Implemented in `src/app/api/pages/[id]/follow-up/route.ts` (Pass 0 direct
text-match, Pass 1 Haiku routing, Pass 2 scoped Sonnet generation, Pass -1
fallback, competitor-URL bypass, sanity check before splice). `npm run build`
passes. Not yet committed — latency/accuracy still needs validating against
real follow-up prompts before this ships. DALL·E-in-follow-up remains TBD/out
of scope, unchanged.

## Context

`token-reduction.md` shipped the output-side fix: for a patch edit, Claude returns
only the changed section(s) instead of the full document (`applyPatch()` in
`src/app/api/pages/[id]/follow-up/route.ts`). That cut output tokens from ~15K to
~500-1.5K.

The input side was not touched. Today, every follow-up call — patch, style, or
structural — sends the **entire minified page HTML** plus the **entire
`schema_json`** to Claude in one call (`follow-up/route.ts`, the `textContent`
built around line 303), because that single call both classifies the edit type
and produces the result. Real measured latency is currently **~58-60s**, well
above the ~5-10s `token-reduction.md` targeted, because prefill of that large,
uncached HTML blob happens on every single call — system-prompt caching
(`ai-client.ts`, `cache_control: ephemeral`) already handles the static prompt
text, but the page HTML changes every message and can never be cached.

Lovable-style comparison: they scope edits to the relevant component file(s)
and route small/cheap models for structure-parsing vs. a stronger model only
for the actual generation. We can't adopt their component-file architecture
(flat HTML is a deliberate, already-decided constraint — see
`token-reduction.md`, "React vs Flat HTML"), but the equivalent move is
available to us for free: `<!-- SL:name -->` markers are already natural chunk
boundaries. We just aren't using them to shrink the *input* yet.

## Goal

For the patch case (the majority of edits, per the follow-up system prompt's
own classification bias), stop sending the whole page. Send only the target
section's HTML.

| | Current | Proposed |
|---|---|---|
| Input tokens (patch case) | ~15-30K (full page) | ~1-3K (target section + optional head) |
| Calls per patch edit | 1 | 2 (routing + scoped generation) |
| Routing model | n/a | fast/cheap (Haiku) |
| Generation model | Sonnet | Sonnet (unchanged) |
| Target | — | cut 58-60s down meaningfully; exact number TBD by prototype |

`style` and `structural` edits are unaffected — they need whole-page context
and keep using the current full-page path.

## Design — Two Passes

### Pass 0 — Direct Text-Match Pre-Check (free, no AI call)

Not every prompt needs Haiku to guess. Many real prompts quote actual page
content verbatim, e.g.:
- `"You didn't set your alarm for 5:27 AM. Your blinds did." Change this heading to a better one.`
- `Change the font size of this "Nightset mounts over your existing blinds..." to 20px`

Before calling Haiku at all: regex-search the user's instruction for quoted
text, then substring-match that quote against the **full text** of each
section (not just a short preview — the quote could be anywhere in a long
section). If exactly one section matches, skip Pass 1 entirely and go
straight to Pass 2 (scoped generation) with that section. Free, instant, and
100% accurate when it hits — no model guessing involved.

Falls through to Pass 1 if: no quoted text in the prompt, or the quote
matches zero or multiple sections.

### Pass 1 — Routing (cheap, tiny input, fast model)

Input:
- `schema_json` (already small/structured)
- List of section names (from existing `<!-- SL:name -->` markers)
- A short auto-extracted text preview per section — derived via regex/string
  matching, **not AI** (e.g. first ~150 chars of visible text per section) —
  needed so the router has enough signal to disambiguate "the popup form" vs
  "the footer form" without seeing full markup
- For image-referencing prompts: also include image `src`/`data-field` per
  section, not just text preview — text previews are useless when the
  instruction is about an image ("use this image instead of this image")
- The user's instruction

Output: `{ type: "patch" | "style" | "structural", target_sections: string[], confidence: "high" | "low" }`

Model: fast/cheap tier (Haiku), not Sonnet — this is classification/routing,
not code generation, mirroring Lovable's small-model-for-structure /
large-model-for-generation split.

### Pass -1 — Low-Confidence / Ambiguous Fallback (no new mechanism — reuses today's path)

Some prompts have no section reference, no quotable text, and no clear
single target — e.g. "make the page feel more premium," "add urgency
everywhere," or an image swap where the page has several images and the user
just says "this image." Forcing a guess here is the actual risk to
correctness, not a latency win worth taking.

Rule: if Pass 1 returns `confidence: "low"`, OR `target_sections` implies
more sections than a patch should touch (today's threshold is already 1-3
sections, see system prompt), OR the prompt clearly asks for something
outside follow-up's scope (e.g. a *new* generated image/logo — DALL·E is not
wired into `follow-up/route.ts` today, only into the initial-build and
structural-schema paths) — **skip scoping entirely and fall back to the
current single-call full-page path**, unchanged. Never let the router force
a wrong-but-confident-looking guess through to Pass 2.

**Verified gap — competitor URL must bypass Pass 1 entirely, checked in code
before any AI call runs:**
Today, "a competitor/reference URL in the prompt always means `structural`"
is enforced only by an *instruction inside the main system prompt* — the
existing single call reads the full page + full rule set and decides. Pass 1
(Haiku, working off short previews) would never see that rule and could
misroute a URL-bearing prompt into a scoped `patch`, which is wrong (a URL
means full-page/competitor-replication rebuild, not a section tweak).
`mentionedUrls` is already computed early in `follow-up/route.ts` via
`extractUrls(prompt)` before any AI call — so this must be checked in code
(free, no AI) as a hard bypass: if `mentionedUrls.length > 0`, skip Pass
0/1/2 entirely and go straight to today's existing full-page path, exactly
as it works now.

### Pass 2 — Scoped Generation (Sonnet, only if `type: patch`)

Input:
- A trimmed patch-only system prompt: drop the classify/structural/style
  instructions (routing already decided), **keep every safety rule** —
  data-field preservation, the `!important` CSS-specificity check, the JS
  safety skeleton, the surgical-change rule
- Only the target section(s)' HTML, extracted via the same marker-span logic
  `applyPatch()` already uses to locate `<!-- SL:name -->...<!-- /SL:name -->`
  spans
- Only the schema slice for that section (filter `schema_json` by the
  `sectionName.*` key prefix) — not the full schema
- The instruction

Output: same `{ sections: [{ name, html }] }` shape as today.

Splicing: unchanged — reuse the existing `applyPatch()` verbatim.

If `type: style` or `type: structural`: fall back to the current full-page
single-call path exactly as it works today. No behavior change for those
cases.

## Correctness Guardrails (this is the part that must not regress)

The output contract and splice mechanism don't change — only what context the
model sees does. Risk is concentrated in two places:

1. **Router mis-targets the section.** The patch call will "succeed" against
   the wrong content — a correctness bug, not a crash. Mitigated by giving the
   router real per-section text previews, not just names. This is the main
   thing to validate against real edit prompts before shipping — accuracy of
   `target_sections` is the metric that matters most, more than latency.

2. **Under-scoping.** Rare cross-section edits ("match this button's color to
   the one in pricing") need multiple sections in one patch call. The router
   must be able to return multiple `target_sections`; the scoped call should
   never have to improvise on content it wasn't given.

Additional safeguards to add:

- **Schema slicing prevents drift.** Sending only that section's schema keys
  means the model can't rename/touch fields belonging to other sections — it
  never sees them.
- **Sanity check before splice.** Before accepting the scoped response,
  verify the returned fragment's outer tag/class roughly matches what was
  sent in (catches "model echoed a full document" or "model returned an
  empty/garbage fragment"). If the check fails, don't splice — fall back to
  the current full-page path for that one request rather than silently
  corrupting the section.
- **`head`/global CSS changes are unaffected.** `head` is already just
  another SL section; the router routes global color/font asks to it exactly
  as today's single-pass classification does.
- **Truncation risk goes down, not up** — scoped output is smaller, so
  `maxTokens` for pass 2 can be set tighter than the current 32000 ceiling.

## Prompt Categories Considered (real examples walked through before writing todos)

| Prompt example | Category | How it's handled |
|---|---|---|
| `"You didn't set your alarm for 5:27 AM..." Change this heading to a better one.` | Exact quoted text | Pass 0 direct text-match — no AI routing call needed |
| `Change the font size of this "Nightset mounts over your existing blinds..." to 20px` | Exact quoted text | Pass 0 direct text-match |
| `update the FAQs section design` | Named section | Pass 1 — section name itself is the match signal |
| `[image] use this image instead of this image` (page has multiple images) | Ambiguous image reference | Pass 1 must see image `src`/field data, not just text preview; if still ambiguous → Pass -1 fallback (full page) |
| `create a new logo and replace it with the current logo` | Multi-section (navbar + footer) + new-image generation | DALL·E is **not** wired into `follow-up/route.ts` today (TBD, separate/out of scope) — naturally falls to `style`/`structural` full-page path since it touches 2+ sections; no scoping logic needs to special-case this |
| `make the page feel more premium` / no section reference, no quote | Fully ambiguous | Pass 1 must return `confidence: "low"` → Pass -1 fallback, never force a guess |

## Open Questions / Prototype Plan

- [x] Implement Pass 0 (direct text-match pre-check): extract quoted
      substrings from the instruction, substring-match against full section
      text (not previews), route straight to Pass 2 on a unique match —
      `extractQuotedPhrases` / `tryDirectQuoteMatch` in `follow-up/route.ts`
- [x] Implement Pass 1 (Haiku routing call): section names + text previews +
      image `src` data + schema_json + instruction → `{ type,
      target_sections, confidence }` — `tryHaikuRouting`, model
      `claude-haiku-4-5-20251001`
- [x] Implement Pass -1 (fallback rule): low confidence, target_sections
      naming an unknown section, >3 sections, or a routing/generation call
      throwing → drop straight to today's existing full-page single-call
      path, unchanged — implemented as `scopedApplied` staying `false`
- [x] Implement Pass 2 (scoped generation): trimmed patch-only system prompt
      (`SCOPED_PATCH_SYSTEM_PROMPT`) + target section(s) HTML + schema slice
      + instruction → reuse `applyPatch()` verbatim for splicing
- [x] Add the sanity check before splice (outer tag match via `outerTag()` /
      `sanityCheckScopedSection()`) — on failure, falls through to the
      full-page path for that section rather than splicing (chosen over a
      scoped retry, to keep the failure mode simple and match the existing
      "skip silently, don't corrupt" pattern already used elsewhere in this
      route)
- [x] Add the competitor-URL bypass: `slSections`/`quoteMatchSection` are
      pre-empted to `[]`/`null` whenever `mentionedUrls.length > 0` (computed
      via the existing `extractUrls(prompt)`), so scoping is never attempted
      at all when a URL is mentioned — falls straight to today's unchanged
      full-page path
- [ ] Measure real latency split: how much of the current 58-60s is prefill
      of the full HTML vs. generation time, to confirm the input-scoping
      theory actually delivers the expected win in production
- [ ] No feature flag exists yet — the scoped path is always attempted (with
      automatic fallback baked in whenever confidence/targeting isn't solid),
      not gated behind an env var/rollout toggle. Add one if a staged rollout
      is wanted before this reaches real users
- [ ] Validate `target_sections` accuracy and fallback-rate against a batch of
      real follow-up prompts (including the ambiguous/multi-section examples
      in the table below) before trusting this in production
- [ ] Confirm cost delta: Pass 1 is a new, extra call (cheap/fast model +
      tiny input) — net cost per patch edit vs. today's single Sonnet call
- [ ] **TBD, out of scope for now:** wiring DALL·E image generation into
      `follow-up/route.ts` itself (currently only initial build + structural
      schema rebuilds generate images) — needed for prompts like "create a
      new logo," which today can only be satisfied by a full
      structural/style rewrite, not a scoped patch

## Files Likely Touched (when implementation starts)

| File | Change |
|---|---|
| `src/app/api/pages/[id]/follow-up/route.ts` | New routing pass, scoped-generation pass, sanity check before `applyPatch()` |
| `src/lib/ai-client.ts` | Possibly: model override plumbing for a fast/cheap routing tier if not already trivial via `options.model` |

## Files NOT Changed

| File | Reason |
|---|---|
| `applyPatch()` in `follow-up/route.ts` | Splice mechanism is unchanged — same marker regex, same format |
| `src/lib/ai-page-builder.ts` | Section marker injection at build time is unchanged |
| `src/app/api/pages/[id]/schema-from-html/route.ts` | Out of scope — user confirmed this one is fine for now |
