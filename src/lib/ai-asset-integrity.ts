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

import { uploadImage, inlineDataUrisToStorage } from '@/lib/storage';
import { MAX_ASSET_BYTES } from '@/lib/asset-source-resolver';

// Assets larger than this are almost never a logo/inline image we should
// inline-host. Owned by asset-source-resolver so the picker and the fetcher
// enforce one number — offering a file we then refuse to fetch is a promise we
// cannot keep.
export { MAX_ASSET_BYTES } from '@/lib/asset-source-resolver';
// 20s, not 8s: a file at MAX_ASSET_BYTES only downloads inside 8s on a fast
// line, and connection setup to some hosts eats several seconds on its own.
// The import route allows 120s, so this is not the binding constraint — a
// too-tight value here just turns a slow download into a bogus "couldn't
// reach it".
const FETCH_TIMEOUT_MS = 20000;

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
  | 'rate_limited'
  | 'not_shared'
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
 * Split a failed response into a reason the user can act on.
 *
 * Every non-200 used to collapse into "not shared publicly", which is actively
 * misleading: a throttled Google download and a genuinely private file are the
 * same status code, and telling someone to re-share a file that is already
 * shared sends them fixing the wrong thing.
 *
 * The body is read because status alone cannot separate the two — Drive's
 * anti-abuse throttle answers 403 with an HTML interstitial, while the API
 * answers a permission problem with JSON. Error bodies are small, so reading
 * them costs nothing; the read is guarded because a failed response may have
 * no readable body at all.
 */
async function classifyBadStatus(res: Response): Promise<AssetFailureReason> {
  // 429 is unambiguous and needs no body.
  if (res.status === 429) return 'rate_limited';

  let body = '';
  try {
    body = (await res.text()).slice(0, 2000);
  } catch {
    body = '';
  }

  // Google's JSON quota reasons, plus the HTML "Sorry..." page it serves when
  // it decides a client is sending automated queries.
  if (
    /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/i.test(body) ||
    /unusual traffic|automated queries|<title>Sorry/i.test(body)
  ) {
    return 'rate_limited';
  }

  // Drive answers 404 (not 403) for a file that exists but is not shared, so
  // both belong to the same user-facing cause.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return 'not_shared';
  }

  return 'bad_status';
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
      // Belt-and-braces: we never want a cached copy of a multi-MB image.
      // Next's fetch patch only caches when a revalidate is set, so this is
      // inert today — it just keeps it that way if a parent route ever sets one.
      cache: 'no-store',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: await classifyBadStatus(res),
        status: res.status,
      };
    }

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
  } catch (err) {
    // Logged, not swallowed: every distinct cause (abort, DNS, TLS, stream)
    // collapses into the same user-facing "couldn't reach it", so without this
    // line the next failure is undiagnosable.
    console.warn('[fetchAssetBytes] failed', url.slice(0, 200), err);
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

// Matches storage.ts's UPLOAD_CONCURRENCY. Firing every asset at once
// exhausts Supabase Storage's connection pool on image-heavy pages — requests
// past the pool limit time out instead of queuing. Bounding how many are in
// flight keeps each batch within what the pool can actually serve, WITHOUT
// dropping any of them.
const REHOST_CONCURRENCY = 5;

/** Run `fn` over every item, at most `size` in flight at a time. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const width = Math.max(1, size);
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width) {
    out.push(...(await Promise.all(items.slice(i, i + width).map(fn))));
  }
  return out;
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
  /**
   * How many assets to fetch at once. Bounds CONCURRENCY, never the total —
   * `maxAssets` used to be a `.slice(0, 12)` on the work list, which silently
   * left images 13+ pointing at someone else's server forever. A 20-image
   * import got 12 copies and 8 permanent dependencies, and the leftovers were
   * then re-hosted piecemeal by later edits — which is what let re-hosting
   * masquerade as deletion (see the rehostedMap note below).
   */
  concurrency?: number;
  /**
   * Cap on the HEALTH-CHECK probe of images already in our own storage.
   *
   * Unlike re-hosting, this is not correctness: it only reports a file we
   * uploaded that has since gone missing. Probing downloads the bytes, so
   * leaving it uncapped would make every edit re-download every image on the
   * page. Re-hosting is what must never be capped — a skipped copy leaves a
   * permanent dependency on someone else's server.
   */
  maxProbes?: number;
  /**
   * Known asset URLs to re-host wherever they appear, not just in <img src>.
   *
   * Link-imported library images are not downloaded up front any more — they
   * are captioned, offered to the model, and fetched only once one is actually
   * placed. This scan is that fetch, so it has to catch a library URL in a CSS
   * background or a srcset too, not only in an <img>. Exact strings we handed
   * the model, so this stays a substring match and never parses CSS.
   */
  extraUrls?: string[];
}): Promise<{
  html: string;
  rehosted: string[];
  broken: string[];
  /**
   * Old URL → new URL for everything actually moved this run.
   *
   * Callers that compare a page against an EARLIER copy of itself need this:
   * re-hosting rewrites `src` attributes, so an untouched image looks missing
   * when the two sides are diffed on URL. Applying this map to the older copy
   * first makes the comparison apples-to-apples. Empty when nothing moved.
   */
  rehostedMap: Record<string, string>;
}> {
  const { pageSlug, html, concurrency = REHOST_CONCURRENCY, maxProbes = 12, extraUrls = [] } = opts;

  const srcs = new Set<string>();
  const ownSrcs = new Set<string>();
  for (const m of Array.from(html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi))) {
    const src = m[1].trim();
    if (!/^https?:\/\//i.test(src)) continue;
    if (isOwnStorageUrl(src)) {
      ownSrcs.add(src);
      continue;
    }
    srcs.add(src);
  }
  for (const url of extraUrls) {
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (isOwnStorageUrl(url) || ownSrcs.has(url) || srcs.has(url)) continue;
    if (html.includes(url)) srcs.add(url);
  }

  // Never sliced: every foreign URL gets copied, however many there are.
  const targets = Array.from(srcs);
  // Sliced: a best-effort health check, bounded so edits stay fast.
  const ownTargets = Array.from(ownSrcs).slice(0, Math.max(0, maxProbes));
  if (targets.length === 0 && ownTargets.length === 0) {
    return { html, rehosted: [], broken: [], rehostedMap: {} };
  }

  const results = await inBatches(targets, concurrency, async (url) => ({
    url,
    result: await materializeAsset({ pageSlug, url }),
  }));
  // Our own storage URLs are never re-hosted, but they still have to be probed:
  // a logo we uploaded ourselves can be missing or not-an-image, and skipping
  // these outright is how a broken image box in the nav shipped while the
  // pipeline reported success.
  const ownResults = await inBatches(ownTargets, concurrency, async (url) => ({
    url,
    probe: await fetchAssetBytes(url),
  }));

  let out = html;
  const rehosted: string[] = [];
  const broken: string[] = [];
  const rehostedMap: Record<string, string> = {};
  for (const { url, result } of results) {
    if (!result.ok) {
      broken.push(url);
      continue;
    }
    if (result.url === url) continue;
    out = out.split(url).join(result.url);
    rehosted.push(url);
    rehostedMap[url] = result.url;
  }
  for (const { url, probe } of ownResults) {
    if (!probe.ok) broken.push(url);
  }

  return { html: out, rehosted, broken, rehostedMap };
}

/**
 * Apply a rehostedMap to an older copy of the same page.
 *
 * Use before diffing that copy against a re-hosted one — otherwise every moved
 * image reads as deleted, because only its address changed.
 */
export function applyRehostMap(html: string, rehostedMap: Record<string, string>): string {
  const pairs = Object.entries(rehostedMap).filter(([from, to]) => from && from !== to);
  if (pairs.length === 0) return html;
  // ONE pass, longest key first. Replacing sequentially would let a later key
  // rewrite text an earlier one just inserted (A→B then B→C yields C), and
  // would let a short URL that is a prefix of a longer one corrupt it. Neither
  // can arise from a real rehostedMap — its keys are always foreign URLs and
  // its values always our own storage, which is never re-hosted and so never
  // becomes a key — but a single pass makes the function safe to call with any
  // map rather than only the one shape it happens to be handed today.
  const byLength = [...pairs].sort((a, b) => b[0].length - a[0].length);
  const lookup = new Map(byLength);
  const pattern = new RegExp(
    byLength.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
  );
  return html.replace(pattern, (match) => lookup.get(match) ?? match);
}

/**
 * Make an incoming page self-contained: every image it shows becomes a file we
 * host, whoever wrote the markup.
 *
 * TWO ways a page arrives depending on someone else, and every HTML intake has
 * to close both:
 *   1. base64 bytes inlined in the markup  → inlineDataUrisToStorage
 *   2. <img src> pointing at another host  → verifyAndRehostHtmlImages
 *
 * They were closed in different places. Every intake ran (1); only one ran (2).
 * So an Unbounce/Webflow import kept its foreign URLs, and a page stayed one
 * lapsed account away from losing every image on it. Worse, the copy then
 * happened later, DURING an edit — and since the edit path diffs a page against
 * its previous self by image URL, re-hosting mid-edit made untouched images
 * read as deleted: phantom losses, a repair model call per phantom, and a
 * duplicate copy of every image it "restored".
 *
 * One call does both so a seventh intake cannot be added that remembers half.
 *
 * Only <img> is touched. <iframe>, <video>, <source>, <script> and <link> are
 * left exactly as written — an embedded player (Mux, YouTube, Vimeo) is a live
 * service, not an asset to copy, and rewriting its src would break playback.
 *
 * Best-effort on the network half: a slow or unreachable third-party host must
 * never cost someone their upload. Anything missed is picked up later by
 * ensure-editable, schema-from-html, or the edit path — all of which run this
 * same scan.
 *
 * `rehostedMap` is returned for callers holding a SCHEMA alongside the HTML:
 * it stores image URLs too, and the two must not end up pointing at different
 * copies. Callers with no schema can ignore it and take `.html`.
 */
export async function takeOwnershipOfHtmlAssets(
  html: string,
  pageId: string,
): Promise<{ html: string; rehostedMap: Record<string, string> }> {
  const inlined = await inlineDataUrisToStorage(html, pageId);
  try {
    const scan = await verifyAndRehostHtmlImages({ pageSlug: pageId, html: inlined });
    if (scan.rehosted.length > 0 || scan.broken.length > 0) {
      console.log('[asset-integrity] took ownership of page images', {
        pageId,
        rehosted: scan.rehosted.length,
        broken: scan.broken.length,
      });
    }
    return { html: scan.html, rehostedMap: scan.rehostedMap };
  } catch (err) {
    console.warn('[asset-integrity] re-hosting failed — storing HTML with its original image URLs', err);
    return { html: inlined, rehostedMap: {} };
  }
}
