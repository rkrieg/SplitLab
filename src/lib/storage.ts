import fs from 'fs';
import path from 'path';

const STORAGE_DIR = path.join(process.cwd(), '.html-storage');

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function localPath(fileName: string): string {
  return path.join(STORAGE_DIR, fileName);
}

const LOCAL_PREFIX = '/__html_storage__/';
const LOCAL_BUCKET_PREFIX = '/__html_storage__/';

/**
 * Upload HTML content to local filesystem storage.
 * Returns a URL that the serve endpoint can use to retrieve the file.
 */
export async function uploadHtml(
  fileName: string,
  htmlContent: string
): Promise<string> {
  const filePath = localPath(fileName);
  ensureDir(filePath);
  fs.writeFileSync(filePath, htmlContent, 'utf-8');
  return `${LOCAL_PREFIX}${fileName}`;
}

/**
 * Download HTML content from a URL or local storage path.
 */
export async function downloadHtml(url: string): Promise<string> {
  if (url.startsWith(LOCAL_PREFIX) || url.startsWith(LOCAL_BUCKET_PREFIX)) {
    const fileName = url.slice(LOCAL_PREFIX.length);
    const filePath = path.join(STORAGE_DIR, fileName);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    throw new Error(`Local HTML file not found: ${fileName}`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch HTML: ${res.statusText}`);
  return res.text();
}

/**
 * Delete a file from local storage by its fileName (path in storage).
 */
export async function deleteHtmlFile(fileName: string): Promise<void> {
  const filePath = localPath(fileName);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Extract the file name (path) from a storage URL.
 */
export function fileNameFromUrl(url: string): string {
  if (url.startsWith(LOCAL_PREFIX)) {
    return url.slice(LOCAL_PREFIX.length);
  }
  const parts = url.split('/pages/');
  return parts[1] || url.split('/').pop() || '';
}
