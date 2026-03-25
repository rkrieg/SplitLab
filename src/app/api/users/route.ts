import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { randomBytes } from 'crypto';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
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

    // Generate a secure invite token (48 bytes = 64 chars base64url)
    const inviteToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    const { data: user, error } = await db
      .from('users')
      .insert({
        name: data.name,
        email: data.email.toLowerCase(),
        password_hash: '', // No password yet — set via invite link
        role: data.role,
        status: 'invited',
        invite_token: inviteToken,
        invite_expires_at: expiresAt,
      })
      .select('id, name, email, role, status, created_at')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Build the invite URL
    const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
    const inviteUrl = `${APP_URL}/invite/${inviteToken}`;

    // Send invitation email with setup link
    let emailError: string | null = null;
    try {
      const { sendInvitationEmail } = await import('@/lib/email');
      await sendInvitationEmail({
        toName: data.name,
        toEmail: data.email,
        inviteUrl,
        role: data.role,
      });
    } catch (err) {
      emailError = err instanceof Error ? err.message : 'Email send failed';
      console.error('[email] invitation failed:', err);
    }

    return NextResponse.json({ ...user, inviteUrl, emailError }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
