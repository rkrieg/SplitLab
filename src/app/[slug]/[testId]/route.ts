import { NextRequest, NextResponse } from 'next/server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: { slug: string; testId: string } }
) {
  const { testId } = params;

  if (!UUID_REGEX.test(testId)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const serveUrl = new URL(`${APP_URL}/api/serve`);
  serveUrl.searchParams.set('preview_test_id', testId);
  // The visitor-facing URL of this shareable link. /api/serve can't see it (we
  // fetch server-side), but proxy mode needs it as the iframe's sl_purl so form
  // leads report this URL instead of the underlying redirect_url's domain.
  serveUrl.searchParams.set('public_url', request.nextUrl.href);

  // Forward any extra query params (e.g. UTM tags)
  request.nextUrl.searchParams.forEach((value, key) => {
    if (key !== 'preview_test_id') {
      serveUrl.searchParams.set(key, value);
    }
  });

  const cookieHeader = request.headers.get('cookie') || '';
  const userAgent = request.headers.get('user-agent') || '';
  const res = await fetch(serveUrl.toString(), {
    headers: { cookie: cookieHeader, 'user-agent': userAgent },
    // Redirect variants answer with a 302 to the destination site; relay it to
    // the browser instead of following it server-side, which would serve the
    // destination's HTML from this origin and break its relative assets.
    redirect: 'manual',
  });

  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) {
    const redirectResponse = NextResponse.redirect(location, res.status);
    res.headers.getSetCookie?.().forEach((cookie) => {
      redirectResponse.headers.append('Set-Cookie', cookie);
    });
    return redirectResponse;
  }

  const body = await res.arrayBuffer();
  const response = new NextResponse(body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('content-type') || 'text/html',
    },
  });

  res.headers.getSetCookie?.().forEach((cookie) => {
    response.headers.append('Set-Cookie', cookie);
  });

  return response;
}
