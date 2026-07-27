import { db } from '@/lib/supabase-server';

// A page is a "variant page" when some test_variants row serves its HTML
// live via /api/serve. Edits to these pages must land in draft_* columns
// until the user explicitly replaces the live variant or forks a copy —
// see docs discussion in the "Edit with AI" revision (2026-07-27).
export async function getLinkedVariant(pageId: string) {
  const { data } = await db
    .from('test_variants')
    .select('id, name, test_id, tests(name)')
    .eq('page_id', pageId)
    .limit(1)
    .maybeSingle();
  return data;
}

export async function isTestVariantPage(pageId: string): Promise<boolean> {
  const variant = await getLinkedVariant(pageId);
  return !!variant;
}
