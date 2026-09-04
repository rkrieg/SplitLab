import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Browser- and Anthropic-reachable URLs for assets we have NOT downloaded yet.
 *
 * Drive refs (`drive:<id>`) are not URLs — the real Drive URL carries our API
 * key, so it can never leave the server (see ResolvedAsset.url). But the whole
 * "caption first, download last" flow needs those images to be fetchable by
 * three parties that have no session: the browser showing a thumbnail, the
 * caption model, and our own rehost pass reading the finished page. So Drive
 * refs are handed out as a signed proxy URL instead.
 *
 * Signed rather than session-guarded because two of those three callers are not
 * the user's browser. The signature is what stops the route being a free Drive
 * proxy on our API quota.
 */

const SIG_BYTES = 16;

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET?.trim();
  if (!s) throw new Error('NEXTAUTH_SECRET is required to sign asset proxy URLs');
  return s;
}

export function signAssetRef(fileId: string): string {
  return createHmac('sha256', secret()).update(`drive:${fileId}`).digest('hex').slice(0, SIG_BYTES * 2);
}

export function verifyAssetRef(fileId: string, sig: string): boolean {
  let expected: string;
  try {
    expected = signAssetRef(fileId);
  } catch {
    return false;
  }
  if (typeof sig !== 'string' || sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/** Absolute, because the caption model fetches it from outside our network. */
function appOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://www.trysplitlab.com').replace(/\/+$/, '');
}

/**
 * A ResolvedAsset.url turned into something anyone can GET.
 *
 * Returns null for a ref we cannot serve, so callers drop it rather than
 * embedding a string that will 404 on the page later.
 */
export function publicAssetUrl(ref: string): string | null {
  if (!ref.startsWith('drive:')) {
    return /^https?:\/\//i.test(ref) ? ref : null;
  }
  const fileId = ref.slice('drive:'.length);
  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return null;
  if (!process.env.GOOGLE_DRIVE_API_KEY?.trim()) return null;
  try {
    return `${appOrigin()}/api/assets/drive/${encodeURIComponent(fileId)}?sig=${signAssetRef(fileId)}`;
  } catch {
    return null;
  }
}
