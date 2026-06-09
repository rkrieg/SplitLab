import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = req.nextUrl.searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'SplitLab-FrameChecker/1.0' },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    const xfo = res.headers.get('x-frame-options') ?? '';
    const csp = res.headers.get('content-security-policy') ?? '';

    const blockedByXFO = /deny|sameorigin/i.test(xfo);
    const blockedByCSP = /frame-ancestors\s+('none'|[^;]*(?!https?:\/\/\*))/i.test(csp) &&
      !csp.includes('frame-ancestors *');

    const frameable = !blockedByXFO && !blockedByCSP;

    return NextResponse.json({ frameable });
  } catch {
    // Network error / timeout — assume not frameable to be safe
    return NextResponse.json({ frameable: false, error: 'Could not reach URL' });
  }
}
