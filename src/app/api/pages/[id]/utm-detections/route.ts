import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

// UTM Personalization V2 (auto-detection). See docs/utm-personalization-v2-automation.md.
// Lists/updates auto-detected UTM combinations for one page — the data
// behind the glowing-dot indicator and the in-screen detection card.

async function authorize(pageId: string) {
  const session = await getServerSession(authOptions);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  const { data: page } = await db.from('pages').select('workspace_id').eq('id', pageId).single();
  if (!page) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };

  return { wsRole };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;

  const { data, error } = await db
    .from('utm_auto_detections')
    .select('*')
    .eq('page_id', params.id)
    .in('status', ['notified', 'pending'])
    .order('distinct_visitor_count', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ detections: data ?? [] });
}

// Reject a detection (dismiss) or update the page's remembered detection
// field(s) — both are lightweight state changes, not full rule creation
// (that's the separate insert-only personalization-rules/auto endpoint).
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;
  if (auth.wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json();
  const { detection_id, action, detection_fields } = body as {
    detection_id?: string;
    action?: 'reject';
    detection_fields?: string[];
  };

  if (detection_id && action === 'reject') {
    const { error } = await db
      .from('utm_auto_detections')
      .update({ status: 'rejected', resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', detection_id)
      .eq('page_id', params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (Array.isArray(detection_fields)) {
    const { error } = await db
      .from('utm_detection_settings')
      .upsert(
        { page_id: params.id, detection_fields, updated_at: new Date().toISOString() },
        { onConflict: 'page_id' }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
}
