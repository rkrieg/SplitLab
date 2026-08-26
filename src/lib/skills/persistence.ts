import { db } from '@/lib/supabase-server';

/**
 * Skills/style read+write for the `pages` row — deliberately non-fatal.
 *
 * Both live in their own migration (062). Selecting a column that does not
 * exist makes PostgREST fail the WHOLE query, so folding `skills` into the
 * existing follow-up SELECT would have turned "migration not applied yet" into
 * "every AI edit 404s". These run as their own query and swallow their errors:
 * the worst case is a page that rebuilds without remembering its skills, never
 * a build that dies.
 */

export interface PageSkillState {
  skills: string[];
  style: string | null;
}

const EMPTY: PageSkillState = { skills: [], style: null };

export async function loadPageSkills(pageId: string): Promise<PageSkillState> {
  try {
    const { data, error } = await db.from('pages').select('skills, style').eq('id', pageId).single();
    if (error || !data) return EMPTY;
    const row = data as { skills?: unknown; style?: unknown };
    return {
      skills: Array.isArray(row.skills) ? row.skills.filter((s): s is string => typeof s === 'string') : [],
      style: typeof row.style === 'string' && row.style ? row.style : null,
    };
  } catch (err) {
    console.warn('[skills] could not read page skills, continuing without them', err);
    return EMPTY;
  }
}

export async function savePageSkills(
  pageId: string,
  state: { skills?: string[] | null; style?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (Array.isArray(state.skills)) patch.skills = state.skills;
  if (state.style !== undefined) patch.style = state.style;
  if (Object.keys(patch).length === 0) return;
  try {
    const { error } = await db.from('pages').update(patch).eq('id', pageId);
    if (error) console.warn('[skills] could not persist page skills', error.message);
  } catch (err) {
    console.warn('[skills] could not persist page skills', err);
  }
}
