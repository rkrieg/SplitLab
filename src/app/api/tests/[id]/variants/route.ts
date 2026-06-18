import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { z } from 'zod';

const addVariantSchema = z.object({
  name: z.string().min(1),
  redirect_url: z.string().url().nullable().optional(),
  html_content: z.string().optional(),
  proxy_mode: z.boolean().optional(),
  traffic_weight: z.number().int().min(0).max(100),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const data = addVariantSchema.parse(body);

    if (!data.redirect_url && !data.html_content) {
      return NextResponse.json({ error: 'Either redirect_url or html_content is required' }, { status: 400 });
    }

    // Fetch test first — needed for both auth and workspace context
    const { data: test, error: testErr } = await db
      .from('tests')
      .select('id, workspace_id')
      .eq('id', params.id)
      .single();
    if (testErr || !test) {
      return NextResponse.json({ error: 'Test not found' }, { status: 404 });
    }

    const wsRole = await resolveWorkspaceRole(test.workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Enforce variant limit per plan (admins bypass).
    // Always check the workspace owner's plan — an invited manager has plan:'free'
    // on their own user row, which would wrongly cap them at 2 variants.
    if (session.user.role !== 'admin') {
      const { data: wsData } = await db
        .from('workspaces')
        .select('client_id')
        .eq('id', test.workspace_id)
        .single();

      let planOwnerId = session.user.id;
      if (wsData) {
        const { data: clientData } = await db
          .from('clients')
          .select('owner_id')
          .eq('id', wsData.client_id)
          .single();
        if (clientData?.owner_id) planOwnerId = clientData.owner_id;
      }

      const { data: userRow } = await db
        .from('users')
        .select('plan')
        .eq('id', planOwnerId)
        .single();

      const plan = userRow?.plan ?? 'free';
      const limit = PLAN_LIMITS[plan]?.variants ?? 2;

      if (isFinite(limit)) {
        const { count } = await db
          .from('test_variants')
          .select('*', { count: 'exact', head: true })
          .eq('test_id', params.id);

        if ((count ?? 0) >= limit) {
          return NextResponse.json(
            { error: `Your plan allows a maximum of ${limit} variants per test. Please upgrade for unlimited variants.`, limitError: true },
            { status: 403 }
          );
        }
      }
    }

    let pageId: string | null = null;

    // If HTML content provided, create a page
    if (data.html_content) {
      const fileName = `${test.workspace_id}/${crypto.randomUUID()}.html`;
      const htmlUrl = await uploadHtml(fileName, data.html_content);

      const { data: page, error: pageErr } = await db
        .from('pages')
        .insert({
          workspace_id: test.workspace_id,
          name: data.name,
          html_url: htmlUrl,
          html_content: data.html_content,
        })
        .select('id')
        .single();

      if (pageErr) return NextResponse.json({ error: pageErr.message }, { status: 500 });
      pageId = page.id;
    }

    // Create variant
    const { error: varErr } = await db.from('test_variants').insert({
      test_id: params.id,
      name: data.name,
      redirect_url: pageId ? null : (data.redirect_url || null),
      page_id: pageId,
      proxy_mode: pageId ? false : (data.proxy_mode ?? true),
      traffic_weight: data.traffic_weight,
      is_control: false,
    });

    if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });

    // Equalize weights across all variants now that a new one was added
    const { data: allVariants } = await db
      .from('test_variants')
      .select('id')
      .eq('test_id', params.id)
      .order('created_at', { ascending: true });

    if (allVariants && allVariants.length > 0) {
      const equalWeight = Math.floor(100 / allVariants.length);
      let rem = 100 - equalWeight * allVariants.length;
      for (const v of allVariants) {
        const w = equalWeight + (rem-- > 0 ? 1 : 0);
        await db.from('test_variants').update({ traffic_weight: w }).eq('id', v.id);
      }
    }

    // Return full test with all variants
    const { data: fullTest } = await db
      .from('tests')
      .select('*, test_variants(*), conversion_goals(*)')
      .eq('id', params.id)
      .single();

    return NextResponse.json(fullTest, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
