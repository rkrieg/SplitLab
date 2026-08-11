import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';

// GET /api/tests/[id]/extra-param-keys
// Ad-tracking params (utm passthrough, click IDs, custom params) actually
// captured for this test, PLUS any custom_utm_params registered for it that
// haven't shown up in a lead yet — minus anything staff dismissed from the
// mapping screen's "new fields" suggestion list.
//
// Deliberately a separate endpoint from /form-field-keys: that one feeds the
// visitor-typed form fields section, this one feeds the ad-params section.
// Merging them would corrupt the meaning of "form field" in the mapping UI
// (see the same note in /api/tests/[id]/form-leads/route.ts).
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const keys = new Set<string>();

  const { data: discovered } = await db.rpc('get_distinct_extra_param_keys', { p_test_id: params.id });
  for (const row of (discovered ?? []) as { key: string }[]) {
    keys.add(row.key);
  }

  const { data: customParams } = await db
    .from('custom_utm_params')
    .select('name, test_id')
    .eq('workspace_id', access.workspaceId)
    .or(`test_id.is.null,test_id.eq.${params.id}`);
  for (const row of customParams ?? []) {
    keys.add(row.name);
  }

  const { data: dismissed } = await db
    .from('dismissed_lead_fields')
    .select('field_key')
    .eq('test_id', params.id);
  const dismissedKeys = (dismissed ?? []).map(row => row.field_key);
  for (const key of dismissedKeys) {
    keys.delete(key);
  }

  // Returned separately (not merged into `keys`) so the mapping screen can
  // offer a "restore" action without re-running discovery — dismissing never
  // deletes the underlying data, so a dismissed key can always come back.
  return NextResponse.json({ keys: Array.from(keys).sort(), dismissed: dismissedKeys.sort() });
}

// POST /api/tests/[id]/extra-param-keys — dismiss a suggested field.
// Never touches test_integration_mappings.field_mappings — dismissing a
// suggestion must not be able to affect what actually gets synced.
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
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 });

  const { error } = await db
    .from('dismissed_lead_fields')
    .upsert({ test_id: params.id, field_key: key }, { onConflict: 'test_id,field_key' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE /api/tests/[id]/extra-param-keys?key=X — un-dismiss (bring it back
// into the suggestion list if the visitor traffic pattern reappears).
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const key = req.nextUrl.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 });

  const { error } = await db
    .from('dismissed_lead_fields')
    .delete()
    .eq('test_id', params.id)
    .eq('field_key', key);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
