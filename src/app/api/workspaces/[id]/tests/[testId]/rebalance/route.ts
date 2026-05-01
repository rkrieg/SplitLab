import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; testId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { testId } = params;

  let approvedVariantIds: string[];
  let rejectedVariantIds: string[];
  let controlWeight: number;
  let variantWeight: number;

  try {
    const body = await request.json();
    approvedVariantIds = body.approved_variant_ids ?? [];
    rejectedVariantIds = body.rejected_variant_ids ?? [];
    controlWeight = body.control_weight ?? 50;
    variantWeight = body.variant_weight ?? 25;
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // Verify test belongs to this workspace
  const { data: test, error: testErr } = await db
    .from('tests')
    .select('id, workspace_id')
    .eq('id', testId)
    .eq('workspace_id', params.id)
    .single();

  if (testErr || !test) {
    return NextResponse.json({ error: 'Test not found' }, { status: 404 });
  }

  // Update control variant weight
  await (db
    .from('test_variants')
    .update({ traffic_weight: controlWeight })
    .eq('test_id', testId)
    .eq('is_control', true) as unknown as Promise<unknown>);

  // Update approved AI variant weights
  if (approvedVariantIds.length > 0) {
    await (db
      .from('test_variants')
      .update({ traffic_weight: variantWeight, is_active: true })
      .eq('test_id', testId)
      .in('id', approvedVariantIds) as unknown as Promise<unknown>);
  }

  // Disable rejected variants (zero weight / inactive)
  if (rejectedVariantIds.length > 0) {
    await (db
      .from('test_variants')
      .update({ traffic_weight: 0, is_active: false })
      .eq('test_id', testId)
      .in('id', rejectedVariantIds) as unknown as Promise<unknown>);
  }

  return NextResponse.json({ success: true, test_id: testId });
}
