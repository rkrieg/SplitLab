import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml, fileNameFromUrl, inlineDataUrisToStorage } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { getLinkedVariant } from '@/lib/page-drafts';

// Promotes a variant page's draft (accumulated via AI chat / WYSIWYG edits)
// onto the live HTML a test is actually serving. This is the only place a
// variant page's live columns get touched by the AI editor — everything
// else writes to draft_* until the user explicitly confirms here.
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, schema_json, draft_html_content, draft_schema_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const linkedVariant = await getLinkedVariant(params.id);
  if (!linkedVariant) {
    return NextResponse.json({ error: 'This page is not linked to a test variant' }, { status: 400 });
  }

  if (!page.draft_html_content) {
    return NextResponse.json({ error: 'No unsaved changes to replace the variant with' }, { status: 400 });
  }

  // Swap embedded base64 images for real hosted files before this HTML goes
  // live — see storage.ts's inlineDataUrisToStorage for why. Also cleans up
  // any legacy inline images left over from before this fix existed, since
  // this is the point a draft becomes the page's live content.
  const convertedDraftHtml = await inlineDataUrisToStorage(page.draft_html_content, params.id);

  const storagePath = fileNameFromUrl(page.html_url);
  const htmlUrl = await uploadHtml(storagePath, convertedDraftHtml);

  const updatePayload: Record<string, unknown> = {
    html_url: htmlUrl,
    html_content: convertedDraftHtml.length < 500_000 ? convertedDraftHtml : null,
    draft_html_content: null,
    draft_schema_json: null,
    // Live markup changed — old UTM selectors/rules can't be trusted, same
    // as any other live HTML replacement.
    field_selectors_json: null,
    updated_at: new Date().toISOString(),
  };
  if (page.draft_schema_json) {
    updatePayload.schema_json = page.draft_schema_json;
  }

  await db.from('personalization_rules').delete().eq('page_id', params.id);

  // Live markup replaced by the AI draft — this variant's cached scan no
  // longer reflects the page (same reasoning as the manual-edit path in
  // pages/[id]/route.ts).
  const { data: testRow } = await db
    .from('tests')
    .select('scan_results')
    .eq('id', linkedVariant.test_id)
    .single();
  const existingScans = testRow?.scan_results as { variants?: { variant_id: string }[] } | null;
  if (existingScans?.variants?.some((v) => v.variant_id === linkedVariant.id)) {
    const pruned = { variants: existingScans.variants.filter((v) => v.variant_id !== linkedVariant.id) };
    await db.from('tests').update({ scan_results: pruned }).eq('id', linkedVariant.test_id);
  }

  const { data: updated, error } = await db
    .from('pages')
    .update(updatePayload)
    .eq('id', params.id)
    .select('html_url, schema_json')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ html_url: updated.html_url, schema_json: updated.schema_json });
}
