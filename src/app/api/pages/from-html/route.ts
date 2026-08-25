import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { rescanVariantHtml } from '@/lib/services/scan';
import { takeOwnershipOfHtmlAssets } from '@/lib/ai-asset-integrity';

// Uploading now also copies every foreign image into our storage (see below),
// which is network work proportional to how many images the page has. On the
// platform default (~10-15s) an image-heavy import would have been killed
// mid-copy, so this route needs a real ceiling. Well under the 800s used by
// the AI routes — this is downloads, not generation.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { name, html_content, workspace_id, url_path } = await request.json();

    if (!name || !html_content || !workspace_id || !url_path) {
      return NextResponse.json(
        { error: 'name, html_content, workspace_id, and url_path are required' },
        { status: 400 }
      );
    }

    const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Block duplicate active url_path within the same workspace
    const { data: pathConflict } = await db
      .from('tests')
      .select('id, name')
      .eq('workspace_id', workspace_id)
      .eq('url_path', url_path)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    if (pathConflict) {
      return NextResponse.json(
        { error: `Another active test "${pathConflict.name}" is already running on path "${url_path}". Pause it before creating a new test on the same path.` },
        { status: 409 }
      );
    }

    const pageId = crypto.randomUUID();
    // Swap embedded base64 images for real hosted files before this HTML is
    // ever stored — see storage.ts's inlineDataUrisToStorage for why.
    // Both ways a page can arrive depending on someone else — base64 inlined in
    // the markup, and <img> tags pointing at whoever built it — closed in one
    // call, the same one every other HTML intake uses. See
    // takeOwnershipOfHtmlAssets for why this belongs at intake and not later.
    const convertedHtml = (await takeOwnershipOfHtmlAssets(html_content, pageId)).html;

    const storagePath = `pages/${workspace_id}/${pageId}.html`;
    const publicUrl = await uploadHtml(storagePath, convertedHtml);

    const { error: pageErr } = await db.from('pages').insert({
      id: pageId,
      workspace_id,
      name,
      slug: pageId,
      html_url: publicUrl,
      html_content: convertedHtml.length < 500_000 ? convertedHtml : null,
      status: 'active',
      source_type: 'manual',
      version: 1,
    });

    if (pageErr) return NextResponse.json({ error: pageErr.message }, { status: 500 });

    const { data: test, error: testErr } = await db
      .from('tests')
      .insert({ workspace_id, name, url_path, status: 'active' })
      .select()
      .single();

    if (testErr || !test) {
      return NextResponse.json({ error: testErr?.message ?? 'Failed to create test' }, { status: 500 });
    }

    const { data: newVariant, error: varErr } = await db.from('test_variants').insert({
      test_id: test.id,
      name: 'Control',
      page_id: pageId,
      redirect_url: null,
      proxy_mode: false,
      traffic_weight: 100,
      is_control: true,
    }).select('id').single();

    if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });

    if (newVariant) {
      await rescanVariantHtml(test.id, newVariant.id, 'Control', convertedHtml);
    }

    const { data: fullTest } = await db
      .from('tests')
      .select('*, test_variants(*, pages(id, name)), conversion_goals(*)')
      .eq('id', test.id)
      .single();

    return NextResponse.json(fullTest, { status: 201 });
  } catch (err) {
    console.error('[pages/from-html]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
