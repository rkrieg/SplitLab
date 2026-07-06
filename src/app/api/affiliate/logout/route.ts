import { NextResponse } from 'next/server';
import { AFFILIATE_COOKIE } from '@/lib/affiliate-auth';

export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AFFILIATE_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
