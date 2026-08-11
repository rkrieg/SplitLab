import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { uploadHtml } from '@/lib/storage';
import crypto from 'crypto';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const schema = z.object({
  name: z.string().min(1).max(255),
  url_path: z.string().min(1).max(500),
});

// Duplicate a whole page (test): a fresh test on a new path with a copy of every
// variant and conversion goal. HTML/page-backed variants get their own new page
// + stored HTML copy; redirect variants copy the URL. Created as a draft so it
// doesn't serve until the user reviews and activates it.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Source test
  const { data: src } = await db
    .from('tests')
    .select('workspace_id, name, url_path, status, head_scripts')
    .eq('id', params.id)
    .single();
  if (!src) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(src.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Don't collide with an active test already serving the target path.
  const { data: clash } = await db
    .from('tests')
    .select('name')
    .eq('workspace_id', src.workspace_id)
    .eq('url_path', data.url_path)
    .eq('status', 'active')
    .single();
  if (clash) {
    return NextResponse.json(
      { error: `Another active page "${clash.name}" is already on "${data.url_path}". Choose a different path.` },
      { status: 409 },
    );
  }

  // Create the new test (draft — review before it serves)
  const { data: newTest, error: testErr } = await db
    .from('tests')
    .insert({
      workspace_id: src.workspace_id,
      name: data.name,
      url_path: data.url_path,
      status: 'draft',
      head_scripts: src.head_scripts ?? null,
    } as never)
    .select('id')
    .single();
  if (testErr || !newTest) {
    return NextResponse.json({ error: testErr?.message || 'Failed to duplicate page' }, { status: 500 });
  }

  // Copy variants, keeping an old→new id map for goal remapping.
  const { data: srcVariants } = await db
    .from('test_variants')
    .select('id, name, redirect_url, page_id, proxy_mode, traffic_weight, is_control')
    .eq('test_id', params.id)
    .order('created_at', { ascending: true });

  const variantIdMap = new Map<string, string>();
  for (const v of srcVariants ?? []) {
    let newPageId: string | null = null;
    if (v.page_id) {
      const { data: srcPage } = await db
        .from('pages')
        .select('workspace_id, name, html_content')
        .eq('id', v.page_id)
        .single();
      if (srcPage?.html_content) {
        const fileName = `${srcPage.workspace_id}/${crypto.randomUUID()}.html`;
        const htmlUrl = await uploadHtml(fileName, srcPage.html_content);
        const { data: newPage } = await db
          .from('pages')
          .insert({
            workspace_id: srcPage.workspace_id,
            name: srcPage.name,
            html_url: htmlUrl,
            html_content: srcPage.html_content,
          })
          .select('id')
          .single();
        newPageId = newPage?.id ?? null;
      }
    }

    const { data: newVariant } = await db
      .from('test_variants')
      .insert({
        test_id: newTest.id,
        name: v.name,
        redirect_url: newPageId ? null : v.redirect_url,
        page_id: newPageId,
        proxy_mode: newPageId ? false : v.proxy_mode,
        traffic_weight: v.traffic_weight,
        is_control: v.is_control,
      } as never)
      .select('id')
      .single();
    if (newVariant) variantIdMap.set(v.id, newVariant.id);
  }

  // Copy conversion goals, remapping any variant-scoped ones to the new variants.
  const { data: srcGoals } = await db
    .from('conversion_goals')
    .select('name, type, selector, url_pattern, is_primary, variant_id')
    .eq('test_id', params.id);

  if (srcGoals && srcGoals.length > 0) {
    const goalRows = srcGoals.map((g) => ({
      test_id: newTest.id,
      name: g.name,
      type: g.type,
      selector: g.selector,
      url_pattern: g.url_pattern,
      is_primary: g.is_primary,
      variant_id: g.variant_id ? (variantIdMap.get(g.variant_id) ?? null) : null,
    }));
    await db.from('conversion_goals').insert(goalRows as never);
  }

  const { data: fullTest } = await db
    .from('tests')
    .select('*, test_variants(*, pages(id, name)), conversion_goals(*)')
    .eq('id', newTest.id)
    .single();

  return NextResponse.json(fullTest, { status: 201 });
}
