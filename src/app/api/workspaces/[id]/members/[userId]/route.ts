import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';

const updateSchema = z.object({ role: z.enum(['manager', 'viewer']) });

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; userId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data: membership } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', params.id)
    .eq('user_id', session.user.id)
    .single();
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const body = updateSchema.parse(await request.json());
    const { error } = await db
      .from('workspace_members')
      .update({ role: body.role })
      .eq('workspace_id', params.id)
      .eq('user_id', params.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string; userId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Can't remove yourself
  if (params.userId === session.user.id) {
    return NextResponse.json({ error: "You can't remove yourself from a workspace" }, { status: 400 });
  }

  const { data: membership } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', params.id)
    .eq('user_id', session.user.id)
    .single();
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { error } = await db
    .from('workspace_members')
    .delete()
    .eq('workspace_id', params.id)
    .eq('user_id', params.userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
