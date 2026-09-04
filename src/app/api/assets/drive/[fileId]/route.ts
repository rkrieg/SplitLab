import { NextRequest, NextResponse } from 'next/server';
import { verifyAssetRef } from '@/lib/asset-proxy';
import { driveDownloadUrl, MAX_ASSET_BYTES } from '@/lib/asset-source-resolver';

/**
 * Serve one publicly-shared Drive image through us.
 *
 * Exists so a Drive file we have not downloaded yet still has a URL that a
 * browser, the caption model and our own rehost pass can all GET. The API key
 * stays server-side; the `sig` is what keeps this from being an open proxy.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FETCH_TIMEOUT_MS = 15_000;

export async function GET(
  request: NextRequest,
  { params }: { params: { fileId: string } },
) {
  const fileId = params.fileId;
  const sig = request.nextUrl.searchParams.get('sig') ?? '';
  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId) || !verifyAssetRef(fileId, sig)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const apiKey = process.env.GOOGLE_DRIVE_API_KEY?.trim();
  if (!apiKey) return new NextResponse('Not configured', { status: 404 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(driveDownloadUrl(fileId, apiKey), {
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!res.ok) return new NextResponse('Upstream error', { status: res.status === 404 ? 404 : 502 });

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return new NextResponse('Not an image', { status: 415 });

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_ASSET_BYTES) return new NextResponse('Too large', { status: 413 });

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.byteLength),
        // Signed and immutable per file id, so it is safe to cache hard. Keeps
        // a 500-thumbnail library from hitting Drive once per render.
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
    });
  } catch {
    return new NextResponse('Upstream error', { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
