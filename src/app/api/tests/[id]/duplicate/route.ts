import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { duplicateTest } from '@/lib/services/tests';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const schema = z.object({
  name: z.string().min(1).max(255),
  url_path: z.string().min(1).max(500),
});

// Duplicate a whole page (test): a fresh test on a new path with a copy of every
// variant and conversion goal. See duplicateTest() in @/lib/services/tests —
// shared with the MCP duplicate_test tool.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { data: src } = await db
    .from('tests')
    .select('workspace_id')
    .eq('id', params.id)
    .single();
  if (!src) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(src.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const result = await duplicateTest(params.id, src.workspace_id, data.name, data.url_path);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data, { status: 201 });
}
