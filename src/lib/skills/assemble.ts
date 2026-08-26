import type { Skill } from './types';

/**
 * Pure string assembly for the system prompt. No I/O, no model, no state.
 *
 * It exists so prompt ORDER cannot silently drift. Order is the whole
 * mechanism: the base prompt sets defaults, LOCKED pins what may never move,
 * and skills come last precisely because later text wins on anything that is
 * not locked. If someone reorders these by editing a route by hand, the
 * override model quietly stops working and nothing fails loudly.
 *
 * The user's own brief is NOT assembled here. It stays in the user message,
 * where it outranks every system-prompt default but still loses to LOCKED —
 * that is the priority order we agreed:
 *
 *   LOCKED > user's brief > skills > vertical > base defaults
 */

const OVERRIDE_FOOTER =
  'Where this skill contradicts a default from earlier in this prompt, follow the skill. Where it contradicts the LOCKED RULES block, follow the LOCKED RULES.';

export function skillBlockWithFooter(title: string, block: string): string {
  return `\n\n# SKILL: ${title}\n${block.trim()}\n\n${OVERRIDE_FOOTER}`;
}

export interface AssembleInput {
  /** The existing system prompt, untouched. */
  base: string;
  /** LOCKED_RULES_GENERATE or LOCKED_RULES_BUILD. */
  locked: string;
  /** e.g. "The user selected vertical: saas. <hint>" — generate only. */
  verticalNote?: string | null;
  /**
   * Style direction, when a caller wants it in the SYSTEM prompt.
   *
   * The build route does NOT use this: its style reference has always been
   * assembled into the user message alongside the schema, and moving it would
   * change a prompt that is currently working. Kept in the signature so the
   * documented order stays true if that ever changes.
   */
  styleNote?: string | null;
  skills?: Skill[];
  /** 'generate' picks generateBlock, 'build' picks buildBlock. */
  stage: 'generate' | 'build';
}

export function assembleSystemPrompt(input: AssembleInput): string {
  const { base, locked, verticalNote, styleNote, skills = [], stage } = input;

  const parts: string[] = [base.trimEnd(), locked.trimEnd()];

  if (verticalNote && verticalNote.trim()) parts.push(`\n\n${verticalNote.trim()}`);
  if (styleNote && styleNote.trim()) parts.push(`\n\n${styleNote.trim()}`);

  for (const skill of skills) {
    const block = stage === 'generate' ? skill.generateBlock : skill.buildBlock;
    if (!block || !block.trim()) continue;
    parts.push(skillBlockWithFooter(skill.name, block));
  }

  return parts.join('');
}
