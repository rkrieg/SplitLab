import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { rawQuery, withTransaction } from '@/lib/db';
import { slugify } from '@/lib/utils';
import { z } from 'zod';
import { checkClientLimit } from '@/lib/planLimits';

const createSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).optional(),
  logo_url: z.string().url().optional().nullable(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Only return clients the session user has workspace membership for.
  const clients = await rawQuery<{
    id: string; name: string; slug: string; logo_url: string | null;
    created_at: string; workspaces: unknown[];
  }>(
    `SELECT
       c.id, c.name, c.slug, c.logo_url, c.created_at,
       COALESCE(
         json_agg(
           json_build_object(
             'id', w.id, 'name', w.name, 'slug', w.slug, 'status', w.status,
             'tests', (
               SELECT COALESCE(json_agg(json_build_object('id', t.id, 'status', t.status)), '[]'::json)
               FROM tests t WHERE t.workspace_id = w.id
             )
           )
         ) FILTER (WHERE w.id IS NOT NULL),
         '[]'::json
       ) AS workspaces
     FROM clients c
     JOIN workspaces w ON w.client_id = c.id
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [session.user.id]
  );

  return NextResponse.json(clients);
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limitCheck = await checkClientLimit(session.user.id);
  if (!limitCheck.allowed) return limitCheck.response!;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const slug = data.slug || slugify(data.name);

  // Entire creation is inside one transaction with an advisory lock.
  // The lock is held until COMMIT, serializing concurrent creates for the
  // same user so the plan-limit count is always accurate at insert time.
  const userId = session.user.id;
  const maxClients = limitCheck.max === Infinity ? 999999 : limitCheck.max;

  let result: { id: string; name: string; slug: string; logo_url: string | null } | null = null;
  let limitExceeded = false;

  try {
    result = await withTransaction(async (query) => {
      // Acquire exclusive advisory lock keyed to this user for the duration of
      // this transaction — blocks any other concurrent client inserts for the same user.
      await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [userId]);

      // Check slug uniqueness inside the lock
      const slugRows = await query<{ id: string }>(
        `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
        [slug]
      );
      if (slugRows.length > 0) return null; // handled below as 409

      // Atomic count: count clients this user already has (via workspace_members).
      // All prior workspace_member inserts are visible because they happen inside
      // their own transactions which must have committed before our lock was granted.
      const countRows = await query<{ cnt: string }>(
        `SELECT COUNT(DISTINCT c.id)::text AS cnt
         FROM clients c
         JOIN workspaces w ON w.client_id = c.id
         JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE wm.user_id = $1::uuid`,
        [userId]
      );
      const currentCount = parseInt(countRows[0]?.cnt ?? '0', 10);
      if (currentCount >= maxClients) {
        limitExceeded = true;
        return null;
      }

      // Insert client
      const clientRows = await query<{ id: string; name: string; slug: string; logo_url: string | null }>(
        `INSERT INTO clients (name, slug, logo_url) VALUES ($1, $2, $3) RETURNING id, name, slug, logo_url`,
        [data.name, slug, data.logo_url ?? null]
      );
      const client = clientRows[0];
      if (!client) return null;

      // Auto-create default workspace + membership — inside the same transaction
      // so that concurrent requests see the membership when they acquire the lock.
      const wsRows = await query<{ id: string }>(
        `INSERT INTO workspaces (client_id, name, slug) VALUES ($1, $2, 'default') RETURNING id`,
        [client.id, data.name]
      );
      const wsId = wsRows[0]?.id;
      if (wsId) {
        await query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'manager')`,
          [wsId, userId]
        );
      }

      return client;
    });
  } catch (err) {
    console.error('[clients POST] transaction error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  if (limitExceeded) {
    return NextResponse.json(
      { error: 'plan_limit_exceeded', message: 'Client limit reached for your plan' },
      { status: 403 }
    );
  }
  if (!result) return NextResponse.json({ error: 'Slug already in use' }, { status: 409 });

  return NextResponse.json(result, { status: 201 });
}
