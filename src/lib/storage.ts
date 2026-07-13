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
