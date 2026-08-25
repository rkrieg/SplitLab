import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';
import { isBotRequest } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const testId = params.id;

  const access = await resolveTestWorkspaceRole(testId, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const sp = request.nextUrl.searchParams;

  const variantId  = sp.get('variant_id') || null;
  const dateFrom   = sp.get('from') || null;
  const dateTo     = sp.get('to') || null;
  const search     = sp.get('search') || null;
  const pageStr    = sp.get('page') || '1';
  const limitStr   = sp.get('limit') || '50';
  const page       = Math.max(1, parseInt(pageStr, 10) || 1);
  const limit      = Math.min(200, Math.max(1, parseInt(limitStr, 10) || 50));
  const offset     = (page - 1) * limit;

  // Build query
  let query = db
    .from('form_leads')
    .select('*, test_variants(name)', { count: 'exact' })
    .eq('test_id', testId)
    .order('submitted_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (variantId) query = query.eq('variant_id', variantId);
  if (dateFrom)  query = query.gte('submitted_at', new Date(dateFrom).toISOString());
  if (dateTo) {
    const end = new Date(dateTo);
    end.setUTCHours(23, 59, 59, 999);
    query = query.lte('submitted_at', end.toISOString());
  }
  if (search) {
    // Search within form_fields jsonb (case-insensitive contains)
    query = query.ilike('form_fields::text', `%${search}%`);
  }

  const { data: leads, count, error } = await query;

  if (error) {
    console.error('[form-leads GET] error', error);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }

  // Bot classification is derived here from the user_agent already stored on the
  // row, never written into the table. Two reasons: it needs no migration, so
  // there is no window where a deploy could reject a lead insert and lose a real
  // person's details; and it applies retroactively, so bot leads already sitting
  // in the table get flagged too. Cost is that `total` below stays the raw row
  // count — the flag filters the rendered page, not the query.
  const annotated = (leads ?? []).map((l) => ({
    ...l,
    is_bot: isBotRequest((l.user_agent as string | null) ?? null),
  }));

  // Derive all unique field keys across results for dynamic column headers
  const fieldKeys = Array.from(
    new Set(
      (leads ?? []).flatMap((l) => Object.keys((l.form_fields as Record<string, string>) || {}))
    )
  );

  // Kept SEPARATE from fieldKeys on purpose. fieldKeys means "what the visitor
  // typed" and feeds the HubSpot/webhook field-mapping dropdown via
  // form-field-keys — merging ad params into it would pollute the list of
  // mappable form fields and corrupt that meaning permanently.
  const extraParamKeys = Array.from(
    new Set(
      (leads ?? []).flatMap((l) => Object.keys((l.extra_params as Record<string, string>) || {}))
    )
  ).sort();

  // Which of the 7 dedicated system UTM/click-ID columns actually have a
  // value in this result set — table only renders columns leads actually
  // use instead of always showing all 7 (most tests only use 1-2).
  const SYSTEM_UTM_COLS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'] as const;
  const systemParamKeys = SYSTEM_UTM_COLS.filter((col) =>
    (leads ?? []).some((l) => l[col as keyof typeof l])
  );

  return NextResponse.json({
    leads: annotated,
    fieldKeys,
    extraParamKeys,
    systemParamKeys,
    total: count ?? 0,
    page,
    limit,
  });
}
