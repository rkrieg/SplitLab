import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { sendInvitationEmail } from '@/lib/email';

const createSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['admin', 'manager', 'viewer']),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data, error } = await db
    .from('users')
    .select('id, name, email, role, status, created_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Only admins can create users' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const data = createSchema.parse(body);

    const { data: existing } = await db
      .from('users')
      .select('id')
      .eq('email', data.email.toLowerCase())
      .single();

    if (existing) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const { data: user, error } = await db
      .from('users')
      .insert({
        name: data.name,
        email: data.email.toLowerCase(),
        password_hash: passwordHash,
        role: data.role,
      })
      .select('id, name, email, role, status, created_at')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Send invitation email
    let emailError: string | null = null;
    try {
      await sendInvitationEmail({
        toName: data.name,
        toEmail: data.email,
        temporaryPassword: data.password,
        role: data.role,
      });
    } catch (err) {
      emailError = err instanceof Error ? err.message : 'Email send failed';
      console.error('[email] invitation failed:', err);
    }

    return NextResponse.json({ ...user, emailError }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
