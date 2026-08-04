import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { getLinkedVariant } from '@/lib/page-drafts';
import { PLAN_LIMITS } from '@/lib/plans';
import { z } from 'zod';

const saveAsNewSchema = z.object({
  name: z.string().trim().min(1, 'Variant name is required').max(255),
});

// Forks a variant page's draft into a brand-new page and immediately wires
// it into the same test as a new variant at 0% traffic — the live variant
// and every other variant's traffic split are left completely untouched.
// The user ramps its traffic up manually once they're happy with it.
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
    // no body sent — falls through to the schema check below, which
    // rejects it since name is required
  }
  const parsed = saveAsNewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

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
  const variantName = parsed.data.name;
  const pageName = `${testName ?? 'Test'} - ${variantName}`;

  // Enforce plan's variant-per-test limit — this fork becomes a real variant,
  // same as the manual "Add Variant" flow (admins bypass).
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
        .eq('test_id', linkedVariant.test_id);

      if ((count ?? 0) >= limit) {
        return NextResponse.json(
          { error: `Your plan allows a maximum of ${limit} variants per test. Please upgrade for unlimited variants.`, limitError: true },
          { status: 403 }
        );
      }
    }
  }

  const fileName = `${page.workspace_id}/${crypto.randomUUID()}.html`;
  const htmlUrl = await uploadHtml(fileName, html);

  const { data: newPage, error } = await db
    .from('pages')
    .insert({
      workspace_id: page.workspace_id,
      name: pageName,
      html_url: htmlUrl,
      html_content: html.length < 500_000 ? html : null,
      schema_json: schemaJson ?? null,
      vertical: page.vertical ?? 'other',
      source_type: 'ai_generated',
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Wire the fork into the same test as a new variant at 0% traffic —
  // existing variants' weights are left untouched (no equalization), unlike
  // the manual "Add Variant" flow, since this should start out inert.
  const { error: varErr } = await db.from('test_variants').insert({
    test_id: linkedVariant.test_id,
    name: variantName,
    page_id: newPage.id,
    proxy_mode: false,
    traffic_weight: 0,
    is_control: false,
  });

  if (varErr) {
    return NextResponse.json({ error: varErr.message }, { status: 500 });
  }

  // The fork is "done" — clear the draft on the original so the variant
  // page shows a clean, no-pending-changes state back on the test.
  await db
    .from('pages')
    .update({ draft_html_content: null, draft_schema_json: null })
    .eq('id', params.id);

  return NextResponse.json({ pageId: newPage.id, testId: linkedVariant.test_id });
}
