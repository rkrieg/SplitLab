import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';

export async function POST(request: NextRequest) {
  const { token, password } = await request.json();
  if (!token || !password || password.length < 8) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Find valid reset token
  const { data: reset } = await db
    .from('password_resets')
    .select('user_id, expires_at')
    .eq('token', token)
    .single();

  if (!reset) {
    return NextResponse.json({ error: 'Invalid or expired reset link' }, { status: 400 });
  }

  if (new Date(reset.expires_at) < new Date()) {
    await db.from('password_resets').delete().eq('token', token);
    return NextResponse.json({ error: 'Reset link has expired' }, { status: 400 });
  }

  // Update password
  const passwordHash = await bcrypt.hash(password, 12);
  const { error } = await db
    .from('users')
    .update({ password_hash: passwordHash })
    .eq('id', reset.user_id);

  if (error) {
    return NextResponse.json({ error: 'Failed to update password' }, { status: 500 });
  }

  // Delete used token
  await db.from('password_resets').delete().eq('token', token);

  return NextResponse.json({ ok: true });
}
