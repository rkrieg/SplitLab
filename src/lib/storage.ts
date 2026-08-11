import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'pages';

function getStorageClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Upload HTML content to Supabase Storage.
 * Returns the public URL of the uploaded file.
 */
export async function uploadHtml(
  fileName: string,
  htmlContent: string
): Promise<string> {
  const client = getStorageClient();

  const { error } = await client.storage
    .from(BUCKET)
    .upload(fileName, htmlContent, {
      contentType: 'text/html; charset=utf-8',
      upsert: true,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = client.storage.from(BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

const FAVICON_BUCKET = process.env.SUPABASE_FAVICON_BUCKET || 'favicons';

/**
 * Upload a client logo/favicon to the dedicated public favicons bucket.
 * Returns the public URL of the uploaded file.
 */
export async function uploadFavicon(
  fileName: string,
  data: ArrayBuffer,
  contentType: string
): Promise<string> {
  const client = getStorageClient();

  const { error } = await client.storage
    .from(FAVICON_BUCKET)
    .upload(fileName, data, { contentType, upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: urlData } = client.storage.from(FAVICON_BUCKET).getPublicUrl(fileName);
  return urlData.publicUrl;
}

/**
 * Delete a favicon from the favicons bucket by its public URL. Best-effort.
 */
export async function deleteFaviconByUrl(url: string): Promise<void> {
  const fileName = url.split('?')[0].split(`/${FAVICON_BUCKET}/`)[1];
  if (!fileName) return;
  const client = getStorageClient();
  const { error } = await client.storage.from(FAVICON_BUCKET).remove([fileName]);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

/**
 * Download HTML from storage by path using the service role key (works on private buckets).
 */
export async function downloadHtmlByPath(filePath: string): Promise<string> {
  const client = getStorageClient();
  const { data, error } = await client.storage.from(BUCKET).download(filePath);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
  return data.text();
}

/**
 * Download HTML content from Supabase Storage by public URL.
 */
export async function downloadHtml(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch HTML: ${res.statusText}`);
  return res.text();
}

/**
 * Delete a file from storage by its fileName (path in bucket).
 */
export async function deleteHtmlFile(fileName: string): Promise<void> {
  const client = getStorageClient();
  const { error } = await client.storage.from(BUCKET).remove([fileName]);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

/**
 * Extract the file name (path) from a Supabase Storage public URL.
 */
export function fileNameFromUrl(url: string): string {
  const parts = url.split(`/${BUCKET}/`);
  return parts[1] || '';
}

const IMAGE_BUCKET = 'ai-pages-images';

/**
 * Upload an image to the public ai-pages-images bucket.
 * Path: {pageId}/images/{uuid}.{ext}
 * Returns the public URL.
 */
export async function uploadImage(
  pageId: string,
  buffer: ArrayBuffer,
  mimeType: string,
  ext: string
): Promise<string> {
  const client = getStorageClient();
  const uuid = crypto.randomUUID();
  const filePath = `${pageId}/images/${uuid}.${ext}`;

  const { error } = await client.storage
    .from(IMAGE_BUCKET)
    .upload(filePath, buffer, { contentType: mimeType, upsert: false });

  if (error) throw new Error(`Image upload failed: ${error.message}`);

  const { data } = client.storage.from(IMAGE_BUCKET).getPublicUrl(filePath);
  return data.publicUrl;
}

/**
 * Delete all images for a page from the public ai-pages-images bucket.
 * Called when a page is deleted.
 */
export async function deletePageImages(pageId: string): Promise<void> {
  const client = getStorageClient();
  const { data: files } = await client.storage
    .from(IMAGE_BUCKET)
    .list(`${pageId}/images`);

  if (!files || files.length === 0) return;

  const paths = files.map(f => `${pageId}/images/${f.name}`);
  await client.storage.from(IMAGE_BUCKET).remove(paths);
}

// Only base64 image data URIs — deliberately narrower than data-uri-strip.ts's
// generic `data:` matcher (which just needs to hide bytes from the AI for a
// request). This one has to positively identify "this is a base64 image"
// before decoding it, so e.g. `data:image/svg+xml,%3Csvg...` (URL-encoded,
// not base64) is correctly left alone rather than corrupted by a base64 decode.
const DATA_IMAGE_URI_PATTERN = 'data:image\\/(jpeg|jpg|png|webp|gif|svg\\+xml);base64,([A-Za-z0-9+/=]+)';

const MIME_EXT_MAP: Record<string, { mimeType: string; ext: string }> = {
  jpeg: { mimeType: 'image/jpeg', ext: 'jpg' },
  jpg: { mimeType: 'image/jpeg', ext: 'jpg' },
  png: { mimeType: 'image/png', ext: 'png' },
  webp: { mimeType: 'image/webp', ext: 'webp' },
  gif: { mimeType: 'image/gif', ext: 'gif' },
  'svg+xml': { mimeType: 'image/svg+xml', ext: 'svg' },
};

// Below this, leave the image inlined — a tiny icon/spacer isn't worth an
// extra network round trip, and it's usually inlined on purpose.
const MIN_CONVERTIBLE_IMAGE_BYTES = 2 * 1024;

// Firing every embedded image at Supabase Storage at once (unbounded
// Promise.all) exhausts its connection pool on image-heavy pages — uploads
// past the pool limit time out instead of queuing. Capping concurrency keeps
// each batch within what the pool can actually serve.
const UPLOAD_CONCURRENCY = 5;

// `Buffer.from(x, 'base64')` never throws on malformed input — it just
// best-effort decodes whatever it can. That means a bug in our own regex
// (mis-capturing the payload) would silently produce corrupted bytes with no
// error to catch. Checking the decoded buffer's magic bytes against the mime
// type the data URI itself declared catches that before anything gets
// uploaded — a mismatch means OUR extraction went wrong, not that the source
// image was already broken (a genuinely corrupt source image would still
// carry its own correct-but-truncated signature and pass this check, same as
// it does today embedded inline).
function decodedBytesMatchDeclaredType(buffer: Buffer, subtype: string): boolean {
  switch (subtype) {
    case 'png':
      return buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    case 'jpeg':
    case 'jpg':
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'gif':
      return buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF';
    case 'webp':
      return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    case 'svg+xml':
      // Text format, no fixed binary signature — trust the declared mime type.
      return true;
    default:
      return false;
  }
}

/**
 * Finds every base64 data:image/... URI in html, uploads each unique one
 * (skipping anything under ~2KB) to the public ai-pages-images bucket, and
 * splices the real data: URI for the resulting public URL — so a page
 * uploaded with embedded photos ends up with normal <img src> links instead
 * of multi-hundred-KB inline strings.
 *
 * Never partially applies: any failure for one image (decode, signature
 * mismatch, upload error) just leaves that one data URI exactly as it was.
 * A fresh RegExp is constructed per call (not a shared module-level one) so
 * concurrent requests in the same process never race on `lastIndex`.
 */
export async function inlineDataUrisToStorage(html: string, pageId: string): Promise<string> {
  const re = new RegExp(DATA_IMAGE_URI_PATTERN, 'gi');
  const matches = new Map<string, { subtype: string; base64: string }>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [full, subtypeRaw, base64] = m;
    matches.set(full, { subtype: subtypeRaw.toLowerCase(), base64 });
  }
  if (matches.size === 0) return html;

  const replacements = new Map<string, string>();
  const entries = Array.from(matches.entries());
  for (let i = 0; i < entries.length; i += UPLOAD_CONCURRENCY) {
    const batch = entries.slice(i, i + UPLOAD_CONCURRENCY);
    await Promise.all(
      batch.map(async ([dataUri, { subtype, base64 }]) => {
        try {
          const buffer = Buffer.from(base64, 'base64');
          if (buffer.length < MIN_CONVERTIBLE_IMAGE_BYTES) return;
          if (!decodedBytesMatchDeclaredType(buffer, subtype)) {
            console.warn(`[inlineDataUrisToStorage] decoded bytes didn't match declared type "${subtype}" — leaving inline`);
            return;
          }
          const { mimeType, ext } = MIME_EXT_MAP[subtype] ?? { mimeType: `image/${subtype}`, ext: subtype };
          const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
          const url = await uploadImage(pageId, arrayBuffer, mimeType, ext);
          replacements.set(dataUri, url);
        } catch (err) {
          console.warn('[inlineDataUrisToStorage] failed to convert one embedded image — leaving inline', err);
        }
      })
    );
  }
  if (replacements.size === 0) return html;

  let result = html;
  replacements.forEach((url, dataUri) => {
    result = result.split(dataUri).join(url);
  });
  return result;
}
