import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';

// PATCH /api/tests/[id]/variants/[variantId]
// Lightweight per-variant field updates. Currently: clarity_share_url — an
// optional Microsoft Clarity "Share" link that pre-filters recordings/heatmaps
// to this variant. Pass null/'' to clear.
export async function PATCH(req: NextRequest, { params }: { params: { id: string; variantId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: variant } = await db
    .from('test_variants')
    .select('id, test_id')
    .eq('id', params.variantId)
    .single();
  if (!variant || variant.test_id !== params.id) return NextResponse.json({ error: 'Variant not found' }, { status: 404 });

  const { data: test } = await db.from('tests').select('workspace_id').eq('id', params.id).single();
  if (!test) return NextResponse.json({ error: 'Test not found' }, { status: 404 });

  const role = await resolveWorkspaceRole(test.workspace_id, session.user.id, session.user.role);
  if (!role || role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { clarity_share_url?: string | null };
  const update: Record<string, unknown> = {};

  if ('clarity_share_url' in body) {
    const raw = (body.clarity_share_url ?? '').toString().trim();
    if (raw && !/^https:\/\/(clarity\.microsoft\.com|[a-z0-9.-]*\.clarity\.ms)\//i.test(raw)) {
      return NextResponse.json({ error: 'Paste a Clarity share link (clarity.microsoft.com).' }, { status: 400 });
    }
    update.clarity_share_url = raw || null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { error } = await db.from('test_variants').update(update as never).eq('id', variant.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, ...update });
}
