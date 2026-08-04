import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { getLinkedVariant } from '@/lib/page-drafts';
import { PLAN_LIMITS } from '@/lib/plans';
import { z } from 'zod';

const saveAsVariantSchema = z.object({
  test_id: z.string().uuid(),
  name: z.string().trim().min(1, 'Variant name is required').max(255),
});

// Wires a standalone AI page directly into an existing test as a new variant
// at 0% traffic — no copy, no new page row. The page keeps living in the AI
// Pages list; this just gives it a second home. Since it isn't a fork, the
// page can only ever be linked into one test (enforced below) — otherwise an
// edit meant for one test would silently change what another test serves,
// because both would share this same page's HTML.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // no body sent — falls through to the schema check below
  }
  const parsed = saveAsVariantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  const { data: page } = await db
    .from('pages')
    .select('id, workspace_id, html_content, html_url')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!page.html_content && !page.html_url) {
    return NextResponse.json({ error: 'Build this page before adding it to a test' }, { status: 400 });
  }

  const existingLink = await getLinkedVariant(params.id);
  if (existingLink) {
    return NextResponse.json({ error: 'This page is already associated with a test.' }, { status: 400 });
  }

  const { data: test } = await db
    .from('tests')
    .select('id, workspace_id')
    .eq('id', parsed.data.test_id)
    .single();

  if (!test || test.workspace_id !== page.workspace_id) {
    return NextResponse.json({ error: 'Test not found' }, { status: 404 });
  }

  // Enforce plan's variant-per-test limit — this becomes a real variant, same
  // as the manual "Add Variant" flow (admins bypass).
  if (session.user.role !== 'admin') {
    const { data: wsData } = await db
      .from('workspaces')
      .select('client_id')
      .eq('id', page.workspace_id)
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

    const { data: userRow } = await db.from('users').select('plan').eq('id', planOwnerId).single();
    const plan = userRow?.plan ?? 'free';
    const limit = PLAN_LIMITS[plan]?.variants ?? 2;

    if (isFinite(limit)) {
      const { count } = await db
        .from('test_variants')
        .select('*', { count: 'exact', head: true })
        .eq('test_id', test.id);

      if ((count ?? 0) >= limit) {
        return NextResponse.json(
          { error: `Your plan allows a maximum of ${limit} variants per test. Please upgrade for unlimited variants.`, limitError: true },
          { status: 403 }
        );
      }
    }
  }

  // Wired in at 0% traffic — existing variants' weights are left untouched
  // (no equalization), since this should start out inert until the user
  // ramps traffic up manually.
  const { data: variant, error: varErr } = await db
    .from('test_variants')
    .insert({
      test_id: test.id,
      name: parsed.data.name,
      page_id: page.id,
      proxy_mode: false,
      traffic_weight: 0,
      is_control: false,
    })
    .select('id')
    .single();

  if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });

  return NextResponse.json({ testId: test.id, variantId: variant.id });
}
