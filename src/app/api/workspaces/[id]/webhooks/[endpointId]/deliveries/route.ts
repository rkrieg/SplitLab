import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { rawQuery } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; endpointId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const impersonating = request.headers.get('x-sl-impersonating');
  const userId = impersonating ?? session.user.id;

  const rows = await rawQuery<{ id: string }>(
    `SELECT we.id FROM webhook_endpoints we
     JOIN workspace_members wm ON wm.workspace_id = we.workspace_id
     WHERE we.id = $1 AND we.workspace_id = $2 AND wm.user_id = $3 LIMIT 1`,
    [params.endpointId, params.id, userId]
  );
  if (!rows.length) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const deliveries = await rawQuery<{
    id: string;
    event_type: string;
    response_status: number | null;
    error: string | null;
    duration_ms: number | null;
    created_at: string;
  }>(
    `SELECT id, event_type, response_status, error, duration_ms, created_at
     FROM webhook_deliveries
     WHERE endpoint_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [params.endpointId]
  );

  return NextResponse.json(deliveries);
}
