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
