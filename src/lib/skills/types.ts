/**
 * Skill = a named, user-selectable block of extra instruction appended to the
 * existing generate/build system prompts, plus the read-only checks that prove
 * it landed.
 *
 * A skill's prompt block and its checks live in the SAME file on purpose. A
 * check that drifts out of sync with the rule it verifies becomes noise, and
 * noise in a score panel costs more trust than having no score at all.
 *
 * Skills carry ONLY what the base prompts do not already say. They are not a
 * replacement for the base prompt and they never restate it — ticking a skill
 * must be strictly additive, so an unticked build is exactly today's build.
 */

export interface SkillCheckResult {
  passed: boolean;
  /** One short human sentence. Shown verbatim in the score panel. */
  detail: string;
}

export interface SkillCheck {
  id: string;
  label: string;
  /**
   * Pure and read-only — never mutates or returns HTML.
   *
   * Return `null` for "cannot tell from HTML alone" (no images on the page, no
   * CTA to judge, etc.). A null is dropped from the panel entirely. This is
   * deliberate: a wrong ✗ is worse than a missing row.
   */
  run: (html: string) => SkillCheckResult | null;
}

export interface Skill {
  id: string;
  /** Shown on the card and in the "Built with" line. */
  name: string;
  /** One sentence: what it does. */
  description: string;
  /** When to tick it. */
  useFor: string;
  /** When NOT to tick it — this is what proves the skills differ from each other. */
  notFor: string;
  /** Always on, cannot be unticked. */
  mandatory?: boolean;
  /**
   * Ticked when the builder first opens. The user can untick it.
   *
   * Reserved for skills that are safe on ANY page. A skill whose "not for" is
   * a real scenario (Campaign Mode strips the nav) must never default on — the
   * default has to be the one that cannot surprise someone who never opened
   * this panel.
   */
  defaultOn?: boolean;
  /** Appended to the schema-pass system prompt. Empty string = no schema-stage effect. */
  generateBlock: string;
  /** Appended to the HTML-build system prompt. */
  buildBlock: string;
  checks: SkillCheck[];
}

/** What the score panel renders — one row per check that returned non-null. */
export interface SkillScore {
  skillId: string;
  skillName: string;
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}
