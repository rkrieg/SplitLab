import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { IMP_COOKIE } from '@/lib/impersonation';

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(IMP_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}
