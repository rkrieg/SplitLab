import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { getLinkedVariant } from '@/lib/page-drafts';

// Forks a variant page's draft into a brand-new, standalone AI page — the
// live variant is left completely untouched. The new page shows up in the
// AI Pages list; wiring it into a test as an actual variant is a separate,
// manual "Add Variant" step the user does afterward.
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, vertical, html_content, schema_json, draft_html_content, draft_schema_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const linkedVariant = await getLinkedVariant(params.id);
  if (!linkedVariant) {
    return NextResponse.json({ error: 'This page is not linked to a test variant' }, { status: 400 });
  }

  const html = page.draft_html_content ?? page.html_content;
  if (!html) {
    return NextResponse.json({ error: 'No HTML to save' }, { status: 400 });
  }
  const schemaJson = page.draft_schema_json ?? page.schema_json;

  const testName = Array.isArray(linkedVariant.tests)
    ? (linkedVariant.tests[0] as { name: string } | undefined)?.name
    : (linkedVariant.tests as { name: string } | null)?.name;
  const name = `${testName ?? 'Test'} - ${linkedVariant.name} draft`;

  const fileName = `${page.workspace_id}/${crypto.randomUUID()}.html`;
  const htmlUrl = await uploadHtml(fileName, html);

  const { data: newPage, error } = await db
    .from('pages')
    .insert({
      workspace_id: page.workspace_id,
      name,
      html_url: htmlUrl,
      html_content: html.length < 500_000 ? html : null,
      schema_json: schemaJson ?? null,
      vertical: page.vertical ?? 'other',
      source_type: 'ai_generated',
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // The fork is "done" — clear the draft on the original so the variant
  // page shows a clean, no-pending-changes state back on the test.
  await db
    .from('pages')
    .update({ draft_html_content: null, draft_schema_json: null })
    .eq('id', params.id);

  return NextResponse.json({ pageId: newPage.id, addedToAiPages: true });
}
