/**
 * Asset integrity for anything the AI page builder embeds into HTML.
 *
 * Before this module, a third-party logo/image URL was written straight into
 * <img src> and every "did it work" check was `html.includes(url)` — a string
 * test. A URL that 403s (hotlink protection, referer checks, Next.js image
 * optimizer paths) produced a broken image on the page while the pipeline
 * reported success. Re-hosting means the asset we promise is the asset we
 * serve, and validation failures become visible instead of silent.
 *
 * Fail-closed: when an asset cannot be fetched or is not an image, callers get
 * null and must degrade honestly — never embed the unverified URL.
 */

import { uploadImage } from '@/lib/storage';

/** Assets larger than this are almost never a logo/inline image we should inline-host. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

export interface VerifiedAsset {
  /** Public URL on our own storage — safe to embed. */
  url: string;
  contentType: string;
  bytes: number;
  /** True when the source was already ours and no re-upload was needed. */
  reused: boolean;
}

export type AssetFailureReason =
  | 'not_http'
  | 'fetch_failed'
  | 'bad_status'
  | 'not_an_image'
  | 'too_large'
  | 'upload_failed';

export interface AssetCheckFailure {
  ok: false;
  reason: AssetFailureReason;
  status?: number;
  contentType?: string | null;
}

export type AssetCheckResult = ({ ok: true } & VerifiedAsset) | AssetCheckFailure;

/** URLs we already serve — re-hosting them again would just duplicate storage. */
export function isOwnStorageUrl(url: string): boolean {
  return /supabase\.co\/storage\/v1\/object\/public\//i.test(url);
}

function extensionFor(contentType: string, url: string): string {
  const fromType = /image\/(svg\+xml|png|jpeg|jpg|webp|gif|avif)/i.exec(contentType)?.[1];
  if (fromType) return fromType.toLowerCase() === 'svg+xml' ? 'svg' : fromType.toLowerCase();
  const fromUrl = /\.(svgz?|png|jpe?g|webp|gif|avif)(?:\?|#|$)/i.exec(url)?.[1];
  if (fromUrl) return fromUrl.toLowerCase().replace('svgz', 'svg').replace('jpeg', 'jpg');
  return 'png';
}

/**
 * Fetch + validate a remote asset. Does not upload — use materializeAsset when
 * the asset needs to end up on our storage.
 */
export async function fetchAssetBytes(
  url: string,
): Promise<
  | { ok: true; buffer: ArrayBuffer; contentType: string; bytes: number }
  | AssetCheckFailure
> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'not_http' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Browser-ish headers: some CDNs reject default fetch UAs, which is the
    // very hotlink-protection case that produced broken <img> on live pages.
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) return { ok: false, reason: 'bad_status', status: res.status };

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      return { ok: false, reason: 'not_an_image', contentType, status: res.status };
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0) {
      return { ok: false, reason: 'not_an_image', contentType, status: res.status };
    }
    if (buffer.byteLength > MAX_ASSET_BYTES) {
      return { ok: false, reason: 'too_large', contentType, status: res.status };
    }
    return { ok: true, buffer, contentType, bytes: buffer.byteLength };
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Guarantee an embeddable URL: verify the bytes are a real image and re-host
 * on our storage so the page never depends on a third party staying friendly.
 *
 * Returns null-shaped failure rather than the original URL — callers must not
 * fall back to embedding something they could not verify.
 */
export async function materializeAsset(opts: {
  pageSlug: string;
  url: string;
  /** Skip re-upload when the asset is already served from our storage. */
  reuseOwnStorage?: boolean;
}): Promise<AssetCheckResult> {
  const { pageSlug, url, reuseOwnStorage = true } = opts;

  if (reuseOwnStorage && isOwnStorageUrl(url)) {
    const probe = await fetchAssetBytes(url);
    if (!probe.ok) return probe;
    return {
      ok: true,
      url,
      contentType: probe.contentType,
      bytes: probe.bytes,
      reused: true,
    };
  }

  const fetched = await fetchAssetBytes(url);
  if (!fetched.ok) return fetched;

  try {
    const hosted = await uploadImage(
      pageSlug,
      fetched.buffer,
      fetched.contentType,
      extensionFor(fetched.contentType, url),
    );
    return {
      ok: true,
      url: hosted,
      contentType: fetched.contentType,
      bytes: fetched.bytes,
      reused: false,
    };
  } catch {
    return { ok: false, reason: 'upload_failed' };
  }
}

/** Upload raw inline SVG markup so <img src> works everywhere. */
export async function materializeSvgMarkup(opts: {
  pageSlug: string;
  svg: string;
}): Promise<string | null> {
  const svg = opts.svg.trim();
  if (!/^<svg\b/i.test(svg)) return null;
  try {
    const buffer = Buffer.from(svg, 'utf8');
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    return await uploadImage(opts.pageSlug, ab, 'image/svg+xml', 'svg');
  } catch {
    return null;
  }
}

/**
 * Verify every external <img src> already present in built HTML and swap in
 * re-hosted copies. Applies to any asset the model wrote itself, not just the
 * ones we forced in — that is the difference between "the logo loads" and
 * "no image on this page is broken".
 *
 * Never removes an image it cannot verify: an unreachable URL is reported so
 * callers can decide, because silently deleting content is its own bug.
 */
export async function verifyAndRehostHtmlImages(opts: {
  pageSlug: string;
  html: string;
  /** Cap network work on large pages; remaining URLs are left untouched. */
  maxAssets?: number;
}): Promise<{ html: string; rehosted: string[]; broken: string[] }> {
  const { pageSlug, html, maxAssets = 12 } = opts;

  const srcs = new Set<string>();
  for (const m of Array.from(html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi))) {
    const src = m[1].trim();
    if (!/^https?:\/\//i.test(src)) continue;
    if (isOwnStorageUrl(src)) continue;
    srcs.add(src);
  }

  const targets = Array.from(srcs).slice(0, maxAssets);
  if (targets.length === 0) return { html, rehosted: [], broken: [] };

  const results = await Promise.all(
    targets.map(async (url) => ({ url, result: await materializeAsset({ pageSlug, url }) })),
  );

  let out = html;
  const rehosted: string[] = [];
  const broken: string[] = [];
  for (const { url, result } of results) {
    if (!result.ok) {
      broken.push(url);
      continue;
    }
    if (result.url === url) continue;
    out = out.split(url).join(result.url);
    rehosted.push(url);
  }

  return { html: out, rehosted, broken };
}
