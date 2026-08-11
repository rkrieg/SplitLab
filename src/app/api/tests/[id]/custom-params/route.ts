import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';

// Names tracker.js already auto-detects (see LEGACY_PARAM_KEYS/CLICK_ID_PARAMS/
// EXTRA_ID_PARAMS in src/app/tracker.js/route.ts and src/lib/tracking.ts) —
// registering one of these as "custom" would be a no-op duplicate.
const RESERVED_EXACT = new Set([
  'utm_source', 'utm_medium', 'utm_content', 'utm_term', 'utm_campaign', 'gclid', 'fbclid',
  'fbc_id', 'fbp', 'msclkid', 'ttclid', 'li_fat_id', 'twclid', 'dclid', 'wbraid', 'gbraid',
  'epik', 'sccid', 'irclickid',
  'h_ad_id', 'ad_id', 'adset_id', 'campaign_id', 'creative_id', 'placement_id',
]);

function validateName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Missing name' };
  const name = raw.trim().toLowerCase();
  if (!name) return { ok: false, error: 'Missing name' };
  if (name.length > 100) return { ok: false, error: 'Name too long' };
  if (!/^[a-z0-9_]+$/.test(name)) return { ok: false, error: 'Name must be letters, numbers, underscores only' };
  // Ours — colliding with the sl_ prefix would break the tracker's own
  // detection chain (see isTrackingParam in tracker.js/tracking.ts).
  if (name.startsWith('sl_')) return { ok: false, error: '"sl_" is reserved' };
  if (name.startsWith('utm_') || name.startsWith('hsa_')) {
    return { ok: false, error: 'Already auto-detected — no need to add it' };
  }
  if (RESERVED_EXACT.has(name)) return { ok: false, error: 'Already auto-detected — no need to add it' };
  return { ok: true, name };
}

// GET /api/tests/[id]/custom-params — workspace-wide + this test's custom params
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data, error } = await db
    .from('custom_utm_params')
    .select('id, name, enabled, test_id, created_at')
    .eq('workspace_id', access.workspaceId)
    .or(`test_id.is.null,test_id.eq.${params.id}`)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ params: data ?? [] });
}

// POST /api/tests/[id]/custom-params — { name, scope: 'workspace' | 'test' }
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const validated = validateName(body?.name);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  const scope = body?.scope === 'test' ? 'test' : 'workspace';
  const testId = scope === 'test' ? params.id : null;

  const { data, error } = await db
    .from('custom_utm_params')
    .insert({ workspace_id: access.workspaceId, test_id: testId, name: validated.name, enabled: true })
    .select('id, name, enabled, test_id, created_at')
    .single();

  if (error) {
    // Unique-index violation — already registered at this scope.
    if (error.code === '23505') return NextResponse.json({ error: 'Already added' }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ param: data });
}

// PATCH /api/tests/[id]/custom-params — { id, enabled }
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === 'string' ? body.id : null;
  if (!id || typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: 'Missing id/enabled' }, { status: 400 });
  }

  const { error } = await db
    .from('custom_utm_params')
    .update({ enabled: body.enabled })
    .eq('id', id)
    .eq('workspace_id', access.workspaceId); // scope the write to this workspace

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE /api/tests/[id]/custom-params?id=X
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await db
    .from('custom_utm_params')
    .delete()
    .eq('id', id)
    .eq('workspace_id', access.workspaceId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
