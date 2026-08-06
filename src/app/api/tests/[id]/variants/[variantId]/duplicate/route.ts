import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml, downloadHtml } from '@/lib/storage';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';

type Params = { params: { id: string; variantId: string } };

interface ScanElement {
  type: string;
  id: string | null;
  text: string | null;
  selector?: string | null;
}
interface VariantScan {
  variant_id: string;
  variant_name: string;
  scanned_at: string;
  elements: ScanElement[];
}

// POST /api/tests/[id]/variants/[variantId]/duplicate
// Clones a variant (HTML, Redirect, or Proxy mode) into a new variant on the
// same test. Starts at 0% traffic and is never control — mirrors how
// save-as-variant wires pages in inert, so an active test's live split isn't
// disturbed by adding a copy meant to be tweaked before it goes live.
//
// Intentionally NOT copied: personalization_rules (UTM mappings) and
// conversion_goals — a copied HTML variant gets a brand-new page row (a page
// can only ever back one variant, see getLinkedVariant), and any scan
// elements copied over will show "Setup Goal Tracking" until a goal is
// explicitly enabled for the new variant, same as any fresh scan.
export async function POST(_req: NextRequest, { params }: Params) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data: source, error: sourceErr } = await db
    .from('test_variants')
    .select('id, name, page_id, redirect_url, proxy_mode, pages(html_content, html_url)')
    .eq('id', params.variantId)
    .eq('test_id', params.id)
    .single();

  if (sourceErr || !source) {
    return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
  }

  // Enforce plan's variant-per-test limit (admins bypass) — same check as
  // add-variant and save-as-variant, using the workspace owner's plan so an
  // invited manager's own (possibly 'free') plan row doesn't wrongly cap them.
  if (session.user.role !== 'admin') {
    const { data: wsData } = await db
      .from('workspaces')
      .select('client_id')
      .eq('id', access.workspaceId)
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
        .eq('test_id', params.id);

      if ((count ?? 0) >= limit) {
        return NextResponse.json(
          { error: `Your plan allows a maximum of ${limit} variants per test. Please upgrade for unlimited variants.`, limitError: true },
          { status: 403 }
        );
      }
    }
  }

  const newName = `${source.name} copy`.slice(0, 255);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourcePages = source.pages as any;
  const sourcePage = Array.isArray(sourcePages) ? sourcePages[0] : sourcePages;

  let newPageId: string | null = null;

  // HTML mode: fork a brand-new page row — a page can only ever be linked to
  // one test_variant (getLinkedVariant), so the duplicate can't reuse page_id.
  if (source.page_id) {
    // Large pages (500KB+) are stored with html_content: null and only
    // html_url populated (see replace-variant/route.ts) — fall back to
    // downloading from storage the same way /api/serve resolves a variant's
    // HTML, so duplicating a large page doesn't wrongly look "empty."
    let sourceHtml: string | null = sourcePage?.html_content ?? null;
    if (!sourceHtml && sourcePage?.html_url) {
      try {
        sourceHtml = await downloadHtml(sourcePage.html_url);
      } catch {
        sourceHtml = null;
      }
    }
    if (!sourceHtml) {
      return NextResponse.json({ error: 'This variant has no HTML content to duplicate' }, { status: 400 });
    }
    const fileName = `${access.workspaceId}/${crypto.randomUUID()}.html`;
    const htmlUrl = await uploadHtml(fileName, sourceHtml);

    const { data: newPage, error: pageErr } = await db
      .from('pages')
      .insert({
        workspace_id: access.workspaceId,
        name: newName,
        html_url: htmlUrl,
        // Mirror the same large-page convention as replace-variant — don't
        // cache huge HTML inline in the row, storage is already the source
        // of truth for it via html_url.
        html_content: sourceHtml.length < 500_000 ? sourceHtml : null,
      })
      .select('id')
      .single();

    if (pageErr) return NextResponse.json({ error: pageErr.message }, { status: 500 });
    newPageId = newPage.id;
  }

  // Redirect/Proxy mode: copy the URL + proxy_mode directly, no page involved.
  const { data: newVariant, error: varErr } = await db
    .from('test_variants')
    .insert({
      test_id: params.id,
      name: newName,
      page_id: newPageId,
      redirect_url: newPageId ? null : source.redirect_url,
      proxy_mode: newPageId ? false : source.proxy_mode,
      traffic_weight: 0,
      is_control: false,
      tracking_verified: null,
      duplicated_from_id: source.id,
    })
    .select('id')
    .single();

  if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });

  // Copy the source variant's scan entry (if any) onto the new variant_id.
  // conversion_goals are intentionally left uncopied — copied scan elements
  // with no matching goal render as "Setup Goal Tracking" for the new variant.
  const { data: testRow } = await db
    .from('tests')
    .select('scan_results')
    .eq('id', params.id)
    .single();

  const existingScans = testRow?.scan_results as { variants?: VariantScan[] } | null;
  const sourceScan = existingScans?.variants?.find((v) => v.variant_id === params.variantId);

  if (sourceScan) {
    const clonedScan: VariantScan = { ...sourceScan, variant_id: newVariant.id, variant_name: newName };
    const updatedVariantsScan = [...(existingScans?.variants ?? []), clonedScan];
    await db.from('tests').update({ scan_results: { variants: updatedVariantsScan } }).eq('id', params.id);
  }

  const { data: fullTest, error: fetchErr } = await db
    .from('tests')
    .select('*, test_variants(*, pages(id, name, draft_html_content)), conversion_goals(*)')
    .eq('id', params.id)
    .single();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  return NextResponse.json(fullTest, { status: 201 });
}
