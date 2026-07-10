// Same as the /[slug]/[testId] preview route, but tolerates extra trailing
// segments (e.g. /my-test/{testId}/booking). The trailing path is ignored for
// resolution — it only stays in the browser URL so url_reached goal patterns
// like "/booking" match locally the same way they do on a custom domain.
import { NextRequest, NextResponse } from 'next/server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: { slug: string; testId: string; rest: string[] } }
) {
  const { testId } = params;

  if (!UUID_REGEX.test(testId)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const serveUrl = new URL(`${APP_URL}/api/serve`);
  serveUrl.searchParams.set('preview_test_id', testId);

  // Forward any extra query params (e.g. UTM tags)
  request.nextUrl.searchParams.forEach((value, key) => {
    if (key !== 'preview_test_id') {
      serveUrl.searchParams.set(key, value);
    }
  });

  const cookieHeader = request.headers.get('cookie') || '';
  const res = await fetch(serveUrl.toString(), {
    headers: { cookie: cookieHeader },
    redirect: 'follow',
  });

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
