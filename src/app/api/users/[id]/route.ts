import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  role: z.enum(['admin', 'manager', 'viewer']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  password: z.string().min(8).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Non-admin can only update their own name/password
  const isSelf = session.user.id === params.id;
  if (!isSelf && !['admin', 'super_admin'].includes(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const data = updateSchema.parse(body);

    // Only admins can change roles or status
    if ((data.role || data.status) && !['admin', 'super_admin'].includes(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Only super_admins can modify super_admin accounts (except their own name/password)
    if (!isSelf) {
      const targetUser = await db.from('users').select('role').eq('id', params.id).single();
      if (targetUser.data?.role === 'super_admin' && session.user.role !== 'super_admin') {
        return NextResponse.json({ error: 'Cannot modify a super admin' }, { status: 403 });
      }
    }

    const updatePayload: Record<string, unknown> = {};
    if (data.name) updatePayload.name = data.name;
    if (data.role) updatePayload.role = data.role;
    if (data.status) updatePayload.status = data.status;
    if (data.password) {
      updatePayload.password_hash = await bcrypt.hash(data.password, 12);
    }

    const { data: updated, error } = await db
      .from('users')
      .update(updatePayload)
      .eq('id', params.id)
      .select('id, name, email, role, status, created_at')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['admin', 'super_admin'].includes(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (session.user.id === params.id) {
    return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 });
  }

  // Protect super_admin accounts from being deleted by non-super_admins
  const target = await db.from('users').select('role').eq('id', params.id).single();
  if (target.data?.role === 'super_admin' && session.user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Cannot delete a super admin' }, { status: 403 });
  }

  const { error } = await db.from('users').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
