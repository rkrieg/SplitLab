import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';

export const dynamic = 'force-dynamic';

/**
 * GET /api/invites/[token] — Validate invite token and return user info
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const { data: user, error } = await db
    .from('users')
    .select('id, name, email, role, invite_token, invite_expires_at')
    .eq('invite_token', token)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: 'Invalid or expired invite link' }, { status: 404 });
  }

  if (user.invite_expires_at && new Date(user.invite_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This invite link has expired. Ask your admin to resend it.' }, { status: 410 });
  }

  return NextResponse.json({
    name: user.name,
    email: user.email,
    role: user.role,
  });
}

/**
 * POST /api/invites/[token] — Accept invite and set password
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  let password: string;
  try {
    const body = await request.json();
    password = body.password;
    if (!password || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Find user with this token
  const { data: user, error } = await db
    .from('users')
    .select('id, invite_token, invite_expires_at')
    .eq('invite_token', token)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: 'Invalid or expired invite link' }, { status: 404 });
  }

  if (user.invite_expires_at && new Date(user.invite_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This invite link has expired' }, { status: 410 });
  }

  // Hash password and activate the user
  const passwordHash = await bcrypt.hash(password, 12);

  const { error: updateErr } = await db
    .from('users')
    .update({
      password_hash: passwordHash,
      invite_token: null,
      invite_expires_at: null,
      status: 'active',
    })
    .eq('id', user.id);

  if (updateErr) {
    return NextResponse.json({ error: 'Failed to set password' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
