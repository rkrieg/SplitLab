import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

const ASSETS_BUCKET = 'variant-assets';

const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'font/woff',
  'font/woff2',
  'application/font-woff',
  'application/font-woff2',
];

function sanitizeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Deterministic storage path from URL — hash the URL to avoid path collisions.
 */
async function storagePath(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Preserve original extension for content-type inference
  const pathname = new URL(url).pathname;
  const ext = pathname.split('.').pop()?.toLowerCase() || 'bin';
  const safeExt = ext.match(/^[a-z0-9]{1,10}$/) ? ext : 'bin';

  return `cached/${hex}.${safeExt}`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get('url');

  if (!rawUrl) {
    return NextResponse.json({ error: 'Missing ?url= parameter' }, { status: 400 });
  }

  const url = sanitizeUrl(rawUrl);
  if (!url) {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  const path = await storagePath(rawUrl);

  try {
    // 1. Try serving from cache first
    const { data: cached, error: cacheErr } = await db.storage
      .from(ASSETS_BUCKET)
      .download(path);

    if (!cacheErr && cached) {
      const contentType = cached.type || 'application/octet-stream';
      return new NextResponse(cached, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400, s-maxage=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 2. Fetch from origin
    const originRes = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'SplitLab-AssetProxy/1.0',
        Accept: 'image/*,font/*,*/*',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!originRes.ok) {
      return NextResponse.json(
        { error: `Origin returned ${originRes.status}` },
        { status: 502 }
      );
    }

    const contentType = originRes.headers.get('content-type') || 'application/octet-stream';

    // Validate content type — only allow images and fonts
    const baseType = contentType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(baseType)) {
      return NextResponse.json(
        { error: `Content type not allowed: ${baseType}` },
        { status: 403 }
      );
    }

    const buffer = await originRes.arrayBuffer();

    // 3. Cache in Supabase Storage (fire-and-forget, don't block response)
    db.storage
      .from(ASSETS_BUCKET)
      .upload(path, buffer, {
        contentType,
        upsert: true,
      })
      .catch((err: unknown) => {
        console.error('[proxy-asset] cache upload failed:', err);
      });

    // 4. Return the asset
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error('[proxy-asset] error:', err);
    return NextResponse.json({ error: 'Failed to fetch asset' }, { status: 500 });
  }
}
