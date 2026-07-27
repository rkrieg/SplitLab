import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { isTestVariantPage } from '@/lib/page-drafts';

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

  if (!(await isTestVariantPage(params.id))) {
    return NextResponse.json({ error: 'This page is not linked to a test variant' }, { status: 400 });
  }

  if (!page.draft_html_content) {
    return NextResponse.json({ error: 'No unsaved changes to replace the variant with' }, { status: 400 });
  }

  const storagePath = fileNameFromUrl(page.html_url);
  const htmlUrl = await uploadHtml(storagePath, page.draft_html_content);

  const updatePayload: Record<string, unknown> = {
    html_url: htmlUrl,
    html_content: page.draft_html_content.length < 500_000 ? page.draft_html_content : null,
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

  const { data: updated, error } = await db
    .from('pages')
    .update(updatePayload)
    .eq('id', params.id)
    .select('html_url, schema_json')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ html_url: updated.html_url, schema_json: updated.schema_json });
}
