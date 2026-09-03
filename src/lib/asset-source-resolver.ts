/**
 * Asset source resolver — turn ANY link a user pastes into a flat list of
 * direct image URLs.
 *
 * Before this module the builder understood exactly one kind of link: a URL
 * that *is* an image (see fetchAssetBytes in ai-asset-integrity.ts, which
 * hard-rejects anything whose content-type is not image/*). A Google Drive
 * folder link returns text/html — a JavaScript app shell, not bytes and not
 * even a file list — so it failed that check and the builder silently fell
 * back to generating DALL-E imagery. That is how a real client's building
 * photos got replaced with invented ones.
 *
 * The fix is a translation layer, not a Drive feature: classify the link,
 * expand it to individual image URLs, and hand those to the EXISTING
 * fetchAssetBytes → materializeAsset chain. Nothing downstream changes, and
 * new source types (Dropbox, S3) are a new branch here and nothing else.
 *
 * Listing is deliberately separate from downloading. Listing is metadata and
 * cheap; downloading is bytes, storage and money. We list broadly, show the
 * user what we found, and download only what they keep.
 */

/** What kind of link the user gave us. */
export type AssetSourceKind =
  | 'direct_image'
  | 'drive_folder'
  | 'drive_file'
  | 'bucket'
  | 'webpage'
  | 'unsupported';

export interface ResolvedAsset {
  /**
   * Opaque reference to the image, safe to hand to the browser.
   *
   * A plain https URL for web sources. For Drive it is `drive:<fileId>`, NOT
   * the real download URL: that URL carries GOOGLE_DRIVE_API_KEY as a query
   * param, and this object is serialised straight into a client component.
   * Expand it server-side with toFetchableUrl() at import time.
   */
  url: string;
  /** Human label shown in the picker. Filename when we have one. */
  name: string;
  /** Preview image for the grid. Not hosted by us — may fail to load. */
  thumbnailUrl: string | null;
  /** Bytes, when the source reports it. Used to preselect the biggest files. */
  bytes: number | null;
  /** ISO timestamp, when the source reports it. Secondary preselect sort. */
  modifiedAt: string | null;
  /** Folder path inside the source, e.g. "Photos/Exterior". Empty at root. */
  path: string;
}

export interface AssetSourceResult {
  kind: AssetSourceKind;
  assets: ResolvedAsset[];
  /** True when a guard stopped the walk before the source was exhausted. */
  truncated: boolean;
  /** How many entries we looked at (files + folders), for honest messaging. */
  scanned: number;
  /** User-facing failure reason. Null on success, even with zero assets. */
  error: string | null;
}

// ── Guards ──────────────────────────────────────────────────────────────────
// A client Drive can hold 20,000 files across nested folders. Walking all of it
// costs a paginated API round-trip per folder and would sit there for minutes,
// and nothing downstream can use that many images anyway — a page uses ~8, and
// the model's vision context tops out far below a thousand. So we walk a
// bounded slice, tell the user we stopped, and let them narrow the link.
//
// MAX_DEPTH   — real asset folders nest a level or two ("Photos/Exterior").
//               Five is generous; past that it is someone's whole Drive.
// MAX_SCANNED — hard ceiling on entries examined. Stops the walk dead rather
//               than paginating a huge Drive to completion.
// MAX_ASSETS  — ceiling on images RETURNED, so a folder of 1000 photos does
//               not render 1000 <img> thumbnails and lock up the browser.
// Images-only filtering happens in the API query itself (mimeType contains
// 'image/'), so PDFs, docs and spreadsheets never consume scan budget.
const MAX_DEPTH = 5;
const MAX_SCANNED = 1000;
const MAX_ASSETS = 250;
const MAX_PAGES_PER_FOLDER = 10;
const FETCH_TIMEOUT_MS = 10_000;

/** How many images the picker preselects when the source has more. */
export const DEFAULT_SELECTION_CAP = 20;

/**
 * Hard ceiling on how many images we import from a link into a page's asset
 * library in one go. Higher than DEFAULT_SELECTION_CAP because the flow no
 * longer asks the user to hand-pick — a pasted folder is imported wholesale and
 * handed to the model to choose from. Still bounded: every viewable image is
 * vision-attached to the build call, so this is the real cost/context ceiling.
 * Kept in sync with MAX_LIBRARY_ASSETS in the generate/follow-up routes.
 */
export const MAX_LIBRARY_IMPORT = 40;

/**
 * Hard ceiling on a single asset we will fetch and re-host.
 *
 * Defined here rather than in ai-asset-integrity so this module stays free of
 * the storage/Supabase import chain — it is the low-level half of the pair.
 * ai-asset-integrity imports it back, so there is still exactly one number and
 * the picker cannot drift out of step with what the fetcher will accept.
 *
 * MUST NOT exceed the `file_size_limit` on the Supabase `ai-pages-images`
 * bucket, which is 5 MiB. When this was 8 MiB, a 6-8 MiB file passed our own
 * check, showed up un-greyed in the picker, downloaded in full, and only then
 * died on a 413 from Storage — i.e. we promised the user an image we could
 * never store. If the bucket limit is ever raised, raise this to match; never
 * the other way round.
 */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|svgz?|bmp|tiff?)(?:\?|#|$)/i;

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Hostnames that must never be fetched server-side.
 *
 * This module fetches URLs a signed-in user pastes, which makes it an SSRF
 * surface: without this, "https://169.254.169.254/latest/meta-data/" would be
 * fetched by our server, from inside our network, with our credentials'
 * reachability. Blocking loopback, link-local and RFC1918 space keeps the
 * resolver pointed at the public internet where client assets actually live.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function parseUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (!/^https?:$/.test(url.protocol)) return null;
    if (isBlockedHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** Pull a Drive folder id out of any of the shapes Google hands people. */
export function extractDriveFolderId(raw: string): string | null {
  const url = parseUrl(raw);
  if (!url || !/(^|\.)google\.com$/.test(url.hostname)) return null;
  // /drive/folders/ID and /drive/u/0/folders/ID
  const inPath = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1];
  if (inPath) return inPath;
  // folderview is folder-only by name. NOTE: /open?id= is deliberately absent —
  // Google uses that one form for files AND folders, so it is claimed by
  // extractDriveFileId and disambiguated by mimeType in resolveAssetSource.
  // Guessing "folder" here made a shared single-image link list an empty
  // folder and report "no images in there".
  if (/\/folderview$/.test(url.pathname)) {
    const id = url.searchParams.get('id');
    if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return id;
  }
  return null;
}

/** Pull a Drive single-file id out of the usual share-link shapes. */
export function extractDriveFileId(raw: string): string | null {
  const url = parseUrl(raw);
  if (!url || !/(^|\.)google\.com$/.test(url.hostname)) return null;
  if (extractDriveFolderId(raw)) return null;
  const inPath = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1];
  if (inPath) return inPath;
  if (/\/(uc|open|thumbnail)$/.test(url.pathname)) {
    const id = url.searchParams.get('id');
    if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return id;
  }
  return null;
}

/**
 * Best-effort classification from the URL alone. `probeUnknown` in
 * resolveAssetSource upgrades extension-less CDN links to direct_image.
 */
export function classifyAssetSource(raw: string): AssetSourceKind {
  const url = parseUrl(raw);
  if (!url) return 'unsupported';
  if (extractDriveFolderId(raw)) return 'drive_folder';
  if (extractDriveFileId(raw)) return 'drive_file';
  if (IMAGE_EXT_RE.test(url.pathname)) return 'direct_image';
  // Checked after the image test on purpose: a link straight to one object in
  // a bucket is a direct image and needs no listing call at all.
  if (BUCKET_HOST_PATTERNS.some((re) => re.test(url.hostname))) return 'bucket';
  return 'webpage';
}

// ── Google Drive ────────────────────────────────────────────────────────────

/**
 * Bytes URL for a public Drive file.
 *
 * Deliberately the API's alt=media endpoint rather than the familiar
 * `drive.google.com/uc?export=download&id=…`. That older form returns an HTML
 * "can't scan this file for viruses, confirm?" interstitial once a file is
 * over ~100MB, and serves text/html for it — which fetchAssetBytes would
 * correctly reject as not-an-image, producing a mystery failure on exactly the
 * big hero photos we most want. alt=media always returns raw bytes with the
 * real content-type.
 */
export function driveDownloadUrl(fileId: string, apiKey: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(apiKey)}`;
}

/** Client-safe stand-in for a Drive file. See ResolvedAsset.url. */
export function driveRef(fileId: string): string {
  return `drive:${fileId}`;
}

/**
 * Expand a ResolvedAsset.url into something fetchAssetBytes can actually GET.
 * Server-only — this is where the Drive API key enters the URL.
 *
 * Returns null for a ref we cannot expand (Drive ref with no key configured),
 * so callers skip it rather than fetching the literal string "drive:abc".
 */
export function toFetchableUrl(ref: string): string | null {
  if (!ref.startsWith('drive:')) {
    return /^https?:\/\//i.test(ref) ? ref : null;
  }
  const fileId = ref.slice('drive:'.length);
  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return null;
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY?.trim();
  if (!apiKey) return null;
  return driveDownloadUrl(fileId, apiKey);
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  thumbnailLink?: string;
}

async function driveList(
  folderId: string,
  apiKey: string,
  pageToken: string | null,
): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    key: apiKey,
    // Ask only for what the picker needs. Requesting everything makes the
    // response several times larger for no gain.
    fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink)',
    pageSize: '200',
    orderBy: 'folder,name',
    // Shared drives are a different corpus from "My Drive"; agencies routinely
    // keep client assets on one. Without these two the walk silently returns
    // an empty folder instead of an error, which reads as "no images here".
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  if (pageToken) params.set('pageToken', pageToken);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`drive_list_${res.status}:${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
    return { files: json.files ?? [], nextPageToken: json.nextPageToken ?? null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Breadth-first walk of a public Drive folder tree.
 *
 * Breadth-first on purpose: with a scan budget, the images most likely to be
 * the ones the user means (top-level "Hero", "Logos") should be found before
 * budget is spent deep inside "Archive/2019/raw".
 */
async function walkDriveFolder(
  rootId: string,
  apiKey: string,
): Promise<AssetSourceResult> {
  const assets: ResolvedAsset[] = [];
  const queue: { id: string; path: string; depth: number }[] = [
    { id: rootId, path: '', depth: 0 },
  ];
  // A Drive shortcut can point back at an ancestor folder. Without this the
  // walk revisits it forever until the scan budget runs out and reports a
  // truncated result for a folder that was actually small.
  const visited = new Set<string>([rootId]);
  let scanned = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (scanned >= MAX_SCANNED || assets.length >= MAX_ASSETS) {
      truncated = true;
      break;
    }
    const folder = queue.shift()!;
    let pageToken: string | null = null;
    let pages = 0;

    do {
      const page: { files: DriveFile[]; nextPageToken: string | null } =
        await driveList(folder.id, apiKey, pageToken);
      pageToken = page.nextPageToken;
      pages += 1;

      for (const file of page.files) {
        scanned += 1;
        if (file.mimeType === DRIVE_FOLDER_MIME) {
          if (folder.depth + 1 > MAX_DEPTH) { truncated = true; continue; }
          if (visited.has(file.id)) continue;
          visited.add(file.id);
          queue.push({
            id: file.id,
            path: folder.path ? `${folder.path}/${file.name}` : file.name,
            depth: folder.depth + 1,
          });
          continue;
        }
        if (!file.mimeType?.startsWith('image/')) continue;
        if (assets.length >= MAX_ASSETS) { truncated = true; break; }
        assets.push({
          url: driveRef(file.id),
          name: file.name,
          // Drive's own thumbnail host. Bumped to a usable grid size — the
          // default =s220 is served at whatever Drive feels like.
          thumbnailUrl: file.thumbnailLink
            ? file.thumbnailLink.replace(/=s\d+$/, '=s400')
            : null,
          bytes: file.size ? Number(file.size) || null : null,
          modifiedAt: file.modifiedTime ?? null,
          path: folder.path,
        });
      }

      if (scanned >= MAX_SCANNED || assets.length >= MAX_ASSETS) {
        truncated = true;
        break;
      }
    } while (pageToken && pages < MAX_PAGES_PER_FOLDER);

    if (pageToken) truncated = true;
  }

  return { kind: 'drive_folder', assets, truncated, scanned, error: null };
}

// ── Object storage buckets (S3 and the S3-compatible crowd) ─────────────────

/**
 * Hosts that speak the S3 "list objects" XML API.
 *
 * R2, Spaces and GCS all reimplemented S3's wire format, so one parser covers
 * every one of them and adding another provider is one line here.
 */
const BUCKET_HOST_PATTERNS: RegExp[] = [
  /(^|\.)s3[.-][a-z0-9-]*\.?amazonaws\.com$/i,  // bucket.s3.eu-west-1.amazonaws.com AND s3.amazonaws.com
  /(^|\.)r2\.dev$/i,
  /(^|\.)r2\.cloudflarestorage\.com$/i,
  /(^|\.)digitaloceanspaces\.com$/i,
  /^storage\.googleapis\.com$/i,
];

/**
 * Some providers put the bucket in the hostname (bucket.s3.../photos/) and
 * some put it in the first path segment (s3.amazonaws.com/bucket/photos/).
 * The listing request goes to the bucket root either way, so split the URL
 * into "where the bucket lives" and "what folder inside it they linked".
 */
function splitBucketUrl(url: URL): { base: string; prefix: string } {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  // Path-style: the host is the bare service endpoint, so segment 0 is the
  // bucket name and everything after it is the folder inside.
  const isPathStyle =
    host === 'storage.googleapis.com' || /^s3[.-][a-z0-9-]*\.?amazonaws\.com$/i.test(host);

  if (isPathStyle && segments.length > 0) {
    const [bucket, ...rest] = segments;
    return {
      base: `${url.origin}/${encodeURIComponent(bucket)}`,
      prefix: rest.length > 0 ? `${rest.join('/')}/` : '',
    };
  }
  return {
    base: url.origin,
    prefix: segments.length > 0 ? `${segments.join('/')}/` : '',
  };
}

/** Percent-encode an object key without mangling the slashes between folders. */
function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function firstTag(xml: string, tag: string): string | null {
  return new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)?.[1]?.trim() ?? null;
}

/**
 * List the images in a public bucket.
 *
 * No credentials anywhere — this is the plain unsigned GET that a bucket
 * serves when its owner left listing public. When they did not, S3 answers
 * 403 with an AccessDenied body, and there is genuinely no way in without
 * their keys; we say so rather than pretending the bucket was empty.
 */
async function listBucketObjects(url: URL): Promise<AssetSourceResult> {
  const { base, prefix } = splitBucketUrl(url);
  const assets: ResolvedAsset[] = [];
  let scanned = 0;
  let truncated = false;
  let continuationToken: string | null = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000' });
    if (prefix) params.set('prefix', prefix);
    if (continuationToken) params.set('continuation-token', continuationToken);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let xml: string;
    try {
      const res = await fetch(`${base}/?${params}`, {
        signal: controller.signal,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/xml,text/xml,*/*' },
      });
      xml = await res.text();
      if (!res.ok) {
        const code = firstTag(xml, 'Code');
        if (res.status === 403 || code === 'AccessDenied') {
          return { kind: 'bucket', assets: [], truncated: false, scanned: 0, error: "That bucket doesn't allow listing its contents publicly. Its owner has to turn that on, or send you the individual file links." };
        }
        if (res.status === 404 || code === 'NoSuchBucket') {
          return { kind: 'bucket', assets: [], truncated: false, scanned: 0, error: "That bucket doesn't exist, or the address is wrong." };
        }
        return { kind: 'bucket', assets: [], truncated: false, scanned: 0, error: `That bucket returned ${res.status}.` };
      }
    } catch {
      return { kind: 'bucket', assets: [], truncated: false, scanned: 0, error: "Couldn't reach that bucket." };
    } finally {
      clearTimeout(timeout);
    }

    // A bucket URL that is really a CDN front can answer 200 with a web page.
    // Falling through to the page harvest is far more useful than "0 images".
    if (!/<ListBucketResult/i.test(xml)) {
      return await harvestPageImages(url.href);
    }

    const entryRe = /<Contents>([\s\S]*?)<\/Contents>/gi;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(xml))) {
      scanned += 1;
      if (scanned >= MAX_SCANNED || assets.length >= MAX_ASSETS) { truncated = true; break; }
      const entry = m[1];
      const key = firstTag(entry, 'Key');
      // Keys ending in "/" are the zero-byte markers a console creates to fake
      // a folder — there is no file behind them.
      if (!key || key.endsWith('/')) continue;
      if (!IMAGE_EXT_RE.test(key)) continue;
      const size = Number(firstTag(entry, 'Size'));
      const objectUrl = `${base}/${encodeObjectKey(key)}`;
      const parts = key.split('/');
      const folder = parts.slice(0, -1).join('/');
      assets.push({
        url: objectUrl,
        name: parts[parts.length - 1],
        thumbnailUrl: objectUrl,
        bytes: Number.isFinite(size) && size > 0 ? size : null,
        modifiedAt: firstTag(entry, 'LastModified'),
        path: folder,
      });
    }

    continuationToken = firstTag(xml, 'NextContinuationToken');
    pages += 1;
    if (truncated) break;
    if (continuationToken && pages >= MAX_PAGES_PER_FOLDER) { truncated = true; break; }
  } while (continuationToken);

  return { kind: 'bucket', assets, truncated, scanned, error: null };
}

// ── Generic web page ────────────────────────────────────────────────────────

function absolutize(src: string, base: string): string | null {
  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}

/**
 * The catch-all: fetch a page and take every image on it.
 *
 * Exists so an unrecognised link degrades to "we found some images" instead of
 * "we found nothing". A Notion page, a Webflow site, a shared gallery — none
 * need their own handler to be useful. Plain fetch rather than the Firecrawl
 * path used by ai-competitor-scrape: this is an asset grab, not a design
 * clone, so it must work with no third-party key configured.
 */
async function harvestPageImages(pageUrl: string): Promise<AssetSourceResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  let finalUrl = pageUrl;
  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*' },
    });
    if (!res.ok) {
      return { kind: 'webpage', assets: [], truncated: false, scanned: 0, error: `That page returned ${res.status}.` };
    }
    finalUrl = res.url || pageUrl;
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    // A link with no file extension can still BE an image (CDN URLs like
    // /media?id=123). Classification guessed 'webpage'; the response says
    // otherwise, so treat it as the single direct image it is.
    if (contentType.startsWith('image/')) {
      return {
        kind: 'direct_image',
        assets: [{
          url: finalUrl,
          name: decodeURIComponent(finalUrl.split('/').pop()?.split('?')[0] || 'image'),
          thumbnailUrl: finalUrl,
          bytes: Number(res.headers.get('content-length')) || null,
          modifiedAt: null,
          path: '',
        }],
        truncated: false,
        scanned: 1,
        error: null,
      };
    }
    if (!contentType.includes('html') && !contentType.includes('xml') && contentType) {
      return { kind: 'webpage', assets: [], truncated: false, scanned: 0, error: 'That link is not a web page or an image.' };
    }
    html = await res.text();
  } catch {
    return { kind: 'webpage', assets: [], truncated: false, scanned: 0, error: "Couldn't open that link." };
  } finally {
    clearTimeout(timeout);
  }

  const assets: ResolvedAsset[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  const push = (rawSrc: string) => {
    if (assets.length >= MAX_ASSETS) return;
    const src = rawSrc.trim();
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    // 1x1 beacons, spacers and sprite sheets are never page assets and only
    // add noise to a grid the user has to read.
    if (/spacer|pixel|tracking|beacon|1x1|sprite|favicon/i.test(src)) return;
    const abs = absolutize(src, finalUrl);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    assets.push({
      url: abs,
      name: decodeURIComponent(abs.split('/').pop()?.split('?')[0] || 'image'),
      thumbnailUrl: abs,
      bytes: null,
      modifiedAt: null,
      path: '',
    });
  };

  // og:image first — it is the page's own pick of its best image.
  const og = /<meta[^>]+(?:property|name)\s*=\s*["']og:image(?::url)?["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = og.exec(html))) {
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    if (content) { scanned += 1; push(content); }
  }

  const imgRe = /<img\b([^>]*)>/gi;
  while ((m = imgRe.exec(html)) && assets.length < MAX_ASSETS) {
    scanned += 1;
    const attrs = m[1];
    // Lazy-loading frameworks park the real file in data-src / data-original
    // and leave src as a placeholder, so check those first.
    const src =
      /\bdata-src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ||
      /\bdata-original\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ||
      /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (src) push(src);
    // srcset holds the higher-resolution variants; take the last (largest).
    const srcset = /\bsrcset\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (srcset) {
      const candidates = srcset.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
      const largest = candidates[candidates.length - 1];
      if (largest) push(largest);
    }
  }

  // CSS background images — hero art on marketing sites is often not an <img>.
  const bgRe = /url\(\s*["']?([^"')]+\.(?:png|jpe?g|webp|avif|gif))["']?\s*\)/gi;
  while ((m = bgRe.exec(html)) && assets.length < MAX_ASSETS) {
    scanned += 1;
    push(m[1]);
  }

  return { kind: 'webpage', assets, truncated: assets.length >= MAX_ASSETS, scanned, error: null };
}

/**
 * Find the asset-source links inside a block of prose — a pasted PRD, a brief,
 * a chat message.
 *
 * Exists because that is how the links actually arrive: nobody fills in a
 * dedicated field, they paste the whole brief with the Drive folder sitting in
 * the middle of it. A link the user can see in their own prompt but which the
 * builder ignores reads as broken, however well the picker works.
 *
 * Returns only CONTAINER sources — a Drive folder or file, a bucket listing.
 * Two deliberate exclusions:
 *  - ordinary web pages, which the competitor-scrape path already claims as "a
 *    site to clone"; harvesting every image off a site someone merely name-
 *    dropped is not what they asked for.
 *  - bare image URLs, UNLESS includeDirectImages is set. The edit path must
 *    leave those alone: the follow-up route already detects them through
 *    isImageUrl() and attaches them itself, so importing here as well would
 *    attach the same picture twice, once re-hosted and once not. The create
 *    path has no such detection at all, so there it is the only thing that
 *    makes "use https://site.com/hero.jpg as the hero" do anything.
 */
export function findAssetSourceUrls(
  text: string,
  opts: { includeDirectImages?: boolean } = {},
): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    // Trailing punctuation is part of the sentence, not the URL.
    const url = raw.replace(/[.,;:!?)\]]+$/, '');
    if (seen.has(url)) continue;
    const kind = classifyAssetSource(url);
    const isContainer = kind === 'drive_folder' || kind === 'drive_file' || kind === 'bucket';
    const isDirect = kind === 'direct_image' && !!opts.includeDirectImages;
    if (!isContainer && !isDirect) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function isDriveConfigured(): boolean {
  return !!process.env.GOOGLE_DRIVE_API_KEY?.trim();
}

/**
 * Turn one pasted link into a list of direct image URLs.
 *
 * Never throws — every failure comes back as `error` so the UI can say what
 * went wrong instead of showing an empty grid.
 */
export async function resolveAssetSource(raw: string): Promise<AssetSourceResult> {
  const url = parseUrl(raw);
  if (!url) {
    return { kind: 'unsupported', assets: [], truncated: false, scanned: 0, error: 'That does not look like a link. Paste a full http(s) URL.' };
  }

  const kind = classifyAssetSource(raw);

  try {
    if (kind === 'direct_image') {
      return {
        kind,
        assets: [{
          url: url.href,
          name: decodeURIComponent(url.pathname.split('/').pop() || 'image'),
          thumbnailUrl: url.href,
          bytes: null,
          modifiedAt: null,
          path: '',
        }],
        truncated: false,
        scanned: 1,
        error: null,
      };
    }

    const apiKey = process.env.GOOGLE_DRIVE_API_KEY?.trim();

    if (kind === 'drive_folder') {
      if (!apiKey) {
        return { kind, assets: [], truncated: false, scanned: 0, error: 'Google Drive links are not set up on this server yet. Ask an admin to add a Drive API key.' };
      }
      const folderId = extractDriveFolderId(raw)!;
      return await walkDriveFolder(folderId, apiKey);
    }

    if (kind === 'drive_file') {
      if (!apiKey) {
        return { kind, assets: [], truncated: false, scanned: 0, error: 'Google Drive links are not set up on this server yet. Ask an admin to add a Drive API key.' };
      }
      const fileId = extractDriveFileId(raw)!;
      // Confirm it is an image and grab its real name before offering it — a
      // Drive link gives no extension to guess from.
      const meta = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?key=${encodeURIComponent(apiKey)}&fields=id,name,mimeType,size,modifiedTime,thumbnailLink&supportsAllDrives=true`,
      );
      if (!meta.ok) {
        return { kind, assets: [], truncated: false, scanned: 0, error: 'That Drive file is not shared publicly, or the link is wrong.' };
      }
      const file = (await meta.json()) as DriveFile;
      // An /open?id= link can point at either. Now that we know which, hand a
      // folder to the walker rather than rejecting it as "not an image".
      if (file.mimeType === DRIVE_FOLDER_MIME) {
        return await walkDriveFolder(file.id, apiKey);
      }
      if (!file.mimeType?.startsWith('image/')) {
        return { kind, assets: [], truncated: false, scanned: 1, error: 'That Drive file is not an image.' };
      }
      return {
        kind,
        assets: [{
          url: driveRef(file.id),
          name: file.name,
          thumbnailUrl: file.thumbnailLink?.replace(/=s\d+$/, '=s400') ?? null,
          bytes: file.size ? Number(file.size) || null : null,
          modifiedAt: file.modifiedTime ?? null,
          path: '',
        }],
        truncated: false,
        scanned: 1,
        error: null,
      };
    }

    if (kind === 'bucket') {
      return await listBucketObjects(url);
    }

    return await harvestPageImages(url.href);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.startsWith('drive_list_403')) {
      return { kind, assets: [], truncated: false, scanned: 0, error: 'Google refused that folder. Make sure it is shared as "Anyone with the link".' };
    }
    if (message.startsWith('drive_list_404')) {
      return { kind, assets: [], truncated: false, scanned: 0, error: "That Drive folder doesn't exist, or it isn't shared publicly." };
    }
    console.error('[resolveAssetSource]', kind, message);
    return { kind, assets: [], truncated: false, scanned: 0, error: "Couldn't read that link." };
  }
}

/**
 * Which images to tick by default when the source has more than we want to
 * pull in one go. Biggest first: on a client asset folder the large files are
 * the real photography and the small ones are icons, logos and web-optimised
 * duplicates. Files with no reported size sort after sized ones rather than
 * being dropped, so a page harvest (no sizes at all) keeps document order.
 */
export function preselectAssets(assets: ResolvedAsset[], cap = DEFAULT_SELECTION_CAP): string[] {
  // Anything we already know exceeds the fetch ceiling is left unticked. It is
  // still shown, because the user may want to go get a smaller copy — but
  // preselecting by size and then refusing the biggest files on import would
  // make the default action the one that fails.
  const selectable = assets.filter((a) => !a.bytes || a.bytes <= MAX_ASSET_BYTES);
  if (selectable.length <= cap) return selectable.map((a) => a.url);
  return [...selectable]
    .map((asset, index) => ({ asset, index }))
    .sort((a, b) => {
      const sizeDelta = (b.asset.bytes ?? -1) - (a.asset.bytes ?? -1);
      if (sizeDelta !== 0) return sizeDelta;
      const timeDelta =
        Date.parse(b.asset.modifiedAt ?? '') - Date.parse(a.asset.modifiedAt ?? '');
      if (!Number.isNaN(timeDelta) && timeDelta !== 0) return timeDelta;
      return a.index - b.index;
    })
    .slice(0, cap)
    .map((entry) => entry.asset.url);
}
