import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { IMP_COOKIE } from '@/lib/impersonation';
import { rawQuery } from '@/lib/db';

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { userId } = await request.json();
  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId required' }, { status: 400 });
  }

  // Verify the target user exists
  const rows = await rawQuery<{ id: string; name: string; email: string }>(
    'SELECT id, name, email FROM users WHERE id = $1',
    [userId]
  );
  if (!rows[0]) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const response = NextResponse.json({ ok: true, user: rows[0] });
  response.cookies.set(IMP_COOKIE, userId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8, // 8 hours
  });

  return response;
}
