import type { Skill, SkillScore } from './types';
import { landingPageGenerator } from './landing-page-generator';
import { antiSlop } from './anti-slop';
import { speedStability } from './speed-stability';
import { campaignMode } from './campaign-mode';
import { formsConversion } from './forms-conversion';
import { copyCraft } from './copy-craft';
import { motionPolish } from './motion-polish';

export type { Skill, SkillCheck, SkillScore } from './types';
export { assembleSystemPrompt } from './assemble';
export { LOCKED_RULES_BUILD, LOCKED_RULES_GENERATE } from './locked-rules';

/**
 * The closed skill list. Order here is the order the cards render in and the
 * order the prompt blocks are appended in — the mandatory one first, then most
 * to least broadly useful.
 *
 * Adding a skill is a code change reviewed like any other prompt change. There
 * is deliberately no database table and no runtime file loading: the build call
 * cannot read files, and a skill nobody reviewed is a prompt nobody reviewed.
 */
export const SKILLS: Skill[] = [
  landingPageGenerator,
  copyCraft,
  antiSlop,
  speedStability,
  formsConversion,
  motionPolish,
  campaignMode,
];

export const MANDATORY_SKILL_IDS: string[] = SKILLS.filter((s) => s.mandatory).map((s) => s.id);

/**
 * What the builder opens with — mandatory plus every skill safe on any page.
 *
 * Campaign Mode is deliberately NOT here: it removes the navigation and every
 * non-legal footer link, which is right for an ad landing page and wrong for a
 * homepage. A default nobody chose must never be able to delete something.
 */
export const DEFAULT_SKILL_IDS: string[] = SKILLS.filter((s) => s.mandatory || s.defaultOn).map(
  (s) => s.id,
);

/**
 * Includes the mandatory one, so "7" means "6 optional on top of the base".
 *
 * The cap exists only to keep the build prompt from bloating. It has been
 * raised twice for the same reason each time: it had grown to exactly equal the
 * number of shipped skills, which meant a new skill could not be ticked without
 * unticking an existing one. Keep it at least one above SKILLS.length.
 */
export const MAX_SKILLS = 7;

/**
 * The point past which the picker warns, without stopping anyone.
 *
 * Nothing breaks above this — all seven skills together are under 2% of the
 * model's context window, so size was never the constraint. Attention is: every
 * extra block of rules competes with the others for weight, and rules start
 * quietly losing to each other rather than failing loudly. Five is where that
 * trade stays comfortable, so five is a nudge and MAX_SKILLS stays the wall.
 *
 * Keep this at or above the number of default-on skills: a warning fired by a
 * selection the user never made reads as an error they caused.
 */
export const RECOMMENDED_SKILLS = 5;

export const SKILL_IDS: string[] = SKILLS.map((s) => s.id);

/**
 * ids -> Skill[], mandatory always included, unknown ids dropped.
 *
 * Unknown ids are IGNORED rather than rejected on purpose: an old page saved
 * with a skill id we later renamed must still rebuild, and a stale browser tab
 * posting a dead id should not 400 a build the user already paid for.
 */
export function resolveSkills(ids: unknown): Skill[] {
  const requested = Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string')
    : [];
  const wanted = new Set<string>([...MANDATORY_SKILL_IDS, ...requested]);
  const resolved = SKILLS.filter((s) => wanted.has(s.id));
  if (resolved.length <= MAX_SKILLS) return resolved;
  // Keep the mandatory ones plus the first optional picks in registry order.
  const mandatory = resolved.filter((s) => s.mandatory);
  const optional = resolved.filter((s) => !s.mandatory);
  return [...mandatory, ...optional.slice(0, MAX_SKILLS - mandatory.length)];
}

/** Stable ids for persistence and for the "Built with" line. */
export function skillIds(skills: Skill[]): string[] {
  return skills.map((s) => s.id);
}

export function skillNames(skills: Skill[]): string[] {
  return skills.map((s) => s.name);
}

/**
 * Runs every check of every selected skill against the finished HTML.
 *
 * Read-only, and defensive at two levels: a single check that throws is
 * dropped, and the caller is expected to wrap this whole call in its own
 * try/catch too. A score is a nice-to-have; a page that failed to save because
 * a regex threw is not.
 */
export function runSkillChecks(skills: Skill[], html: string): SkillScore[] {
  const out: SkillScore[] = [];
  for (const skill of skills) {
    for (const check of skill.checks) {
      try {
        const result = check.run(html);
        if (!result) continue;
        out.push({
          skillId: skill.id,
          skillName: skill.name,
          id: check.id,
          label: check.label,
          passed: result.passed,
          detail: result.detail,
        });
      } catch (err) {
        console.error('[skills] check threw, dropped', { skill: skill.id, check: check.id, err });
      }
    }
  }
  return out;
}

/** UI payload — the cards need this on the client, the prompt blocks do not. */
export interface SkillCardInfo {
  id: string;
  name: string;
  description: string;
  useFor: string;
  notFor: string;
  mandatory: boolean;
  defaultOn: boolean;
}

export const SKILL_CARDS: SkillCardInfo[] = SKILLS.map((s) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  useFor: s.useFor,
  notFor: s.notFor,
  mandatory: s.mandatory === true,
  defaultOn: s.defaultOn === true,
}));
