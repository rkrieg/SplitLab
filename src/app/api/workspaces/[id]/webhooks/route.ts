import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { rawQuery } from '@/lib/db';
import { z } from 'zod';

const createSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url(),
  events: z.array(z.enum(['conversion', 'test_status_changed'])).min(1).default(['conversion']),
});

async function getWorkspaceUserId(workspaceId: string, userId: string): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspaceId, userId]
  );
  return rows.length > 0;
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const impersonating = request.headers.get('x-sl-impersonating');
  const userId = impersonating ?? session.user.id;

  const isMember = await getWorkspaceUserId(params.id, userId);
  if (!isMember) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const endpoints = await rawQuery<{
    id: string;
    name: string;
    url: string;
    events: string[];
    secret: string;
    is_active: boolean;
    created_at: string;
    delivery_count: number;
    last_delivery: string | null;
    last_status: number | null;
  }>(
    `SELECT
       we.id, we.name, we.url, we.events, we.secret, we.is_active, we.created_at,
       COUNT(wd.id)::int AS delivery_count,
       MAX(wd.created_at) AS last_delivery,
       (SELECT response_status FROM webhook_deliveries WHERE endpoint_id = we.id ORDER BY created_at DESC LIMIT 1) AS last_status
     FROM webhook_endpoints we
     LEFT JOIN webhook_deliveries wd ON wd.endpoint_id = we.id
     WHERE we.workspace_id = $1
     GROUP BY we.id
     ORDER BY we.created_at DESC`,
    [params.id]
  );

  return NextResponse.json(endpoints);
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const impersonating = request.headers.get('x-sl-impersonating');
  const userId = impersonating ?? session.user.id;

  const isMember = await getWorkspaceUserId(params.id, userId);
  if (!isMember) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.errors }, { status: 400 });

  const { name, url, events } = parsed.data;

  const rows = await rawQuery<{ id: string; name: string; url: string; events: string[]; secret: string; is_active: boolean; created_at: string }>(
    `INSERT INTO webhook_endpoints (workspace_id, name, url, events)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [params.id, name, url, events]
  );

  return NextResponse.json(rows[0], { status: 201 });
}
