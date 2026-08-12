import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { downloadHtmlByPath, fileNameFromUrl, uploadHtml } from '@/lib/storage';
import { isTestVariantPage } from '@/lib/page-drafts';
import { countDataFields, ensureClickToEditFields } from '@/lib/ai-data-field-stamp';

export const dynamic = 'force-dynamic';

/**
 * Pages built before structural stamping (or with schema/HTML text mismatch)
 * have zero [data-field] → click-to-edit is dead. Run once on open when the
 * page already has a schema but the HTML is missing editable handles.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select(
      'workspace_id, html_url, html_content, schema_json, draft_html_content, draft_schema_json',
    )
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const isVariant = await isTestVariantPage(params.id);
  const schema = isVariant
    ? (page.draft_schema_json ?? page.schema_json)
    : page.schema_json;
  if (!schema) {
    return NextResponse.json({ updated: false, reason: 'no_schema' });
  }

  let html: string | null = isVariant
    ? ((page.draft_html_content as string | null) ?? (page.html_content as string | null))
    : (page.html_content as string | null);
  if (!html && page.html_url) {
    try {
      html = await downloadHtmlByPath(fileNameFromUrl(page.html_url));
    } catch {
      html = null;
    }
  }
  if (!html) {
    return NextResponse.json({ updated: false, reason: 'no_html' });
  }

  const beforeCount = countDataFields(html);
  const stamped = ensureClickToEditFields(html, schema);
  const afterCount = countDataFields(stamped);
  if (stamped === html || afterCount === 0) {
    return NextResponse.json({
      updated: false,
      reason: afterCount === 0 ? 'nothing_to_stamp' : 'unchanged',
      field_count: afterCount,
    });
  }

  let htmlUrl = page.html_url as string | null;
  if (isVariant) {
    await db
      .from('pages')
      .update({
        draft_html_content: stamped,
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.id);
  } else {
    const storagePath = page.html_url
      ? fileNameFromUrl(page.html_url)
      : `pages/${params.id}.html`;
    htmlUrl = await uploadHtml(storagePath, stamped);
    await db
      .from('pages')
      .update({
        html_url: htmlUrl,
        html_content: stamped.length < 500_000 ? stamped : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.id);
  }

  console.log('[pages/ensure-editable] stamped data-field for click-to-edit', {
    pageId: params.id,
    beforeCount,
    fields: afterCount,
  });

  return NextResponse.json({
    updated: true,
    html_url: htmlUrl,
    field_count: afterCount,
  });
}
