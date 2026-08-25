import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { downloadHtmlByPath, fileNameFromUrl, uploadHtml } from '@/lib/storage';
import { isTestVariantPage } from '@/lib/page-drafts';
import { countDataFields, ensureClickToEditFields } from '@/lib/ai-data-field-stamp';
import { verifyAndRehostHtmlImages, applyRehostMap } from '@/lib/ai-asset-integrity';

export const dynamic = 'force-dynamic';

// This route now also copies foreign images into our storage, which is network
// work proportional to the page's image count. Without a ceiling it ran on the
// platform default (~10-15s) and an image-heavy page would be killed mid-copy.
export const maxDuration = 300;

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

  // ── Make the page self-contained before anyone edits it ──────────────────
  //
  // This route and schema-from-html are exact complements: that one runs when
  // a page has NO schema, this one when it HAS one. Between them every page
  // opened in the AI editor passes through exactly one of them, so putting the
  // asset copy in both is what makes it unconditional — a page edited long ago
  // under the old code is covered here even though it will never see prep
  // again.
  //
  // Why it has to happen before the first edit and not during one: the edit
  // path diffs the page against its previous self to catch content the model
  // dropped, and re-hosting rewrites `src`, so an image that only changed
  // ADDRESS read as deleted. That produced phantom losses, one repair model
  // call per phantom, and a duplicate copy of every image it "restored".
  //
  // The schema is remapped with the SAME map — it stores image URLs the editor
  // reads for its "current image" thumbnails, and leaving those on the old host
  // would point the page and the editor at two different copies.
  //
  // Best-effort: a slow third-party host must not stop click-to-edit working.
  let workingHtml = html;
  let workingSchema = schema;
  let rehostedCount = 0;
  try {
    const assetScan = await verifyAndRehostHtmlImages({ pageSlug: params.id, html: workingHtml });
    workingHtml = assetScan.html;
    rehostedCount = assetScan.rehosted.length;
    if (Object.keys(assetScan.rehostedMap).length > 0) {
      workingSchema = JSON.parse(
        applyRehostMap(JSON.stringify(workingSchema), assetScan.rehostedMap),
      ) as typeof workingSchema;
    }
    if (assetScan.rehosted.length > 0 || assetScan.broken.length > 0) {
      console.log('[pages/ensure-editable] asset integrity', {
        pageId: params.id,
        rehosted: assetScan.rehosted.length,
        broken: assetScan.broken.length,
      });
    }
  } catch (err) {
    console.warn('[pages/ensure-editable] asset re-hosting failed — keeping original image URLs', err);
  }

  const beforeCount = countDataFields(workingHtml);
  const stamped = ensureClickToEditFields(workingHtml, workingSchema);
  const afterCount = countDataFields(stamped);
  // Either job on its own is a reason to save. Returning early on "nothing to
  // stamp" (as this did when stamping was its only job) would throw away a
  // completed asset copy and leave the page foreign for the next edit to trip
  // over.
  const htmlChanged = stamped !== html;
  const schemaChanged = rehostedCount > 0;
  if (!htmlChanged && !schemaChanged) {
    return NextResponse.json({
      updated: false,
      reason: afterCount === 0 ? 'nothing_to_stamp' : 'unchanged',
      field_count: afterCount,
    });
  }

  // The schema rides along whenever re-hosting moved something. Written to the
  // same column the schema was READ from above (draft for a test variant, live
  // otherwise), so the editor's thumbnails and the page's <img> tags keep
  // pointing at the same copies.
  let htmlUrl = page.html_url as string | null;
  if (isVariant) {
    await db
      .from('pages')
      .update({
        draft_html_content: stamped,
        ...(schemaChanged ? { draft_schema_json: workingSchema } : {}),
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
        ...(schemaChanged ? { schema_json: workingSchema } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.id);
  }

  console.log('[pages/ensure-editable] prepared page for editing', {
    pageId: params.id,
    beforeCount,
    fields: afterCount,
    rehosted: rehostedCount,
  });

  return NextResponse.json({
    updated: true,
    html_url: htmlUrl,
    field_count: afterCount,
  });
}
