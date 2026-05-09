import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { rawQuery } from '@/lib/db';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  url: z.string().url().optional(),
  events: z.array(z.enum(['conversion', 'test_status_changed'])).min(1).optional(),
  is_active: z.boolean().optional(),
});

async function ownsEndpoint(endpointId: string, workspaceId: string, userId: string): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    `SELECT we.id FROM webhook_endpoints we
     JOIN workspace_members wm ON wm.workspace_id = we.workspace_id
     WHERE we.id = $1 AND we.workspace_id = $2 AND wm.user_id = $3 LIMIT 1`,
    [endpointId, workspaceId, userId]
  );
  return rows.length > 0;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string; endpointId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const impersonating = request.headers.get('x-sl-impersonating');
  const userId = impersonating ?? session.user.id;

  const ok = await ownsEndpoint(params.endpointId, params.id, userId);
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.errors }, { status: 400 });

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, val] of Object.entries(parsed.data)) {
    if (val !== undefined) {
      updates.push(`${key} = $${idx++}`);
      values.push(Array.isArray(val) ? val : val);
    }
  }

  if (!updates.length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

  updates.push(`updated_at = now()`);
  values.push(params.endpointId);

  const rows = await rawQuery<{ id: string }>(
    `UPDATE webhook_endpoints SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );

  return NextResponse.json(rows[0]);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; endpointId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const impersonating = request.headers.get('x-sl-impersonating');
  const userId = impersonating ?? session.user.id;

  const ok = await ownsEndpoint(params.endpointId, params.id, userId);
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  await rawQuery('DELETE FROM webhook_endpoints WHERE id = $1', [params.endpointId]);
  return NextResponse.json({ ok: true });
}
