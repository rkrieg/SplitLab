import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';

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

  // Derive all unique field keys across results for dynamic column headers
  const fieldKeys = Array.from(
    new Set(
      (leads ?? []).flatMap((l) => Object.keys((l.form_fields as Record<string, string>) || {}))
    )
  );

  return NextResponse.json({
    leads: leads ?? [],
    fieldKeys,
    total: count ?? 0,
    page,
    limit,
  });
}
