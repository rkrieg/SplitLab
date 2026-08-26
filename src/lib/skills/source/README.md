# Skill source material

Reference only. **Nothing here is read at runtime.**

The AI build call cannot read files — it gets one system prompt string. Every
rule that actually reaches the model lives in the TypeScript modules one
directory up (`landing-page-generator.ts`, `anti-slop.ts`, `speed-stability.ts`,
`campaign-mode.ts`), where each skill's prompt block and its checks sit in the
same file so they cannot drift apart.

These `.md` files are the client-supplied originals the skills were distilled
from, kept here so a future edit can be checked against the source instead of
re-derived from memory. They were copied out of `docs/skills/`, which is
temporary scratch and will be removed by the team.

| File | Became |
|---|---|
| `landing-page-generator.source.md` | `landing-page-generator.ts` — the ~40% our base prompt did not already cover: framework-driven section order, risk reversal, message match, SEO extras |
| `frontend-design.source.md` | `anti-slop.ts` — signature element, restraint, "remove one accessory" |
| `design-principles.source.md` | `anti-slop.ts` — the named banned patterns |
| `design-styles.source.md` | `../../ai-page-exemplars.ts` — the styles `quiet_minimalism`, `bauhaus_geometric`, `brutalist_raw`, plus (2026-08-26) its per-style *field structure* applied to all twelve exemplars: `geometry`, `typeScale`, `signatureMoves`, `avoid`, and the "commit at 80%" closing rule in `styleNoteFromTag()` |

## Deliberately not carried over

- **`SKILL1.md` (claude-design)** — an agency workflow that needs WebSearch,
  asset downloading and a human picking between variations mid-loop. Our build
  is one autonomous call with no tools.
- **`fact-verification.md`** — its entire mechanism is "WebSearch before you
  claim". We have no search in this path. The part that survives without search
  is "never state a fact the brief did not give you", which is already in the
  LOCKED truth rules.
- **`brand-context.md`** (and its byte-identical duplicate) — downloads real
  brand assets off the web. We take assets from the user's own library instead.
- **`output-formats.md`** — decks, posters and PDFs. We build landing pages.
- **`scripts/*.py`** — the equivalent audits are reimplemented as the `checks`
  arrays on each skill, which run in-process on the finished HTML. Two of the
  three Python checks (CTA analysis, conversion checklist) map over cleanly. The
  speed estimator does not: it guesses an LCP number, and we refuse to print a
  millisecond figure we cannot measure.
