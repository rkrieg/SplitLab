import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

/**
 * Coarse mobile/desktop classification from a request's User-Agent header.
 * Used server-side (real UA, not client-supplied) for the device CVR split.
 */
export function getDeviceType(userAgent: string | null): 'mobile' | 'desktop' | 'unknown' {
  if (!userAgent) return 'unknown';
  return /Mobi|Android|iPhone|iPod|IEMobile|BlackBerry|Opera Mini/i.test(userAgent)
    ? 'mobile'
    : 'desktop';
}

/**
 * Real device/browser UA strings that contain a bot signature as a substring.
 * Checked BEFORE the bot pattern and wins outright, because the cost of the two
 * mistakes is not symmetric: wrongly clearing a bot leaves a junk row someone can
 * delete, wrongly flagging a human silently destroys real data.
 *
 * cubot — Android handset brand; its UA reads "Android 10; CUBOT_X30", so the
 * bare `bot` alternative below matches every one of its owners. A \b word
 * boundary cannot separate the two: "CUBOT" has no boundary before BOT, but
 * neither does "Googlebot", so the boundary would drop the real crawlers too.
 */
const BOT_FALSE_POSITIVES = /cubot/i;

/**
 * Conservative non-browser traffic check from the User-Agent header — missing
 * UA (no real browser omits it) or an explicit, well-known bot/script/crawler
 * signature. Deliberately narrow: false positives here silently drop a real
 * visitor's pageview, so this only matches names no real browser UA contains,
 * never generic words that could appear in a legitimate UA string.
 *
 * The link-preview fetchers (whatsapp, pinterest, skype) are matched with a
 * trailing slash on purpose. Those products also ship in-app browsers used by
 * real people, but those report a plain Chrome/Safari UA — only the server-side
 * preview fetcher uses the "Name/version" form, so the slash separates the bot
 * from the human.
 */
export function isBotRequest(userAgent: string | null): boolean {
  if (!userAgent) return true;
  if (BOT_FALSE_POSITIVES.test(userAgent)) return false;
  return /bot|crawler|spider|facebookexternalhit|meta-externalagent|python-requests|python-urllib|go-http-client|okhttp|libwww-perl|scrapy|headlesschrome|phantomjs|slurp|bingpreview|ahrefsbot|semrushbot|mj12bot|petalbot|dataforseo|curl\/|wget\/|node-fetch|axios\/|postmanruntime|whatsapp\/|pinterest\/|skypeuripreview|chrome-lighthouse|pingdom|statuscake|embedly|iframely|google-inspectiontool|google-read-aloud/i.test(userAgent);
}

/**
 * Deterministically assign a variant for a visitor using SHA-256
 * hashing so the same visitor always gets the same variant.
 */
export async function assignVariant<T extends { traffic_weight: number }>(
  sessionId: string,
  testId: string,
  variants: T[]
): Promise<T> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${sessionId}:${testId}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashBytes = new Uint8Array(hashBuffer);

  // Build a 32-bit integer from the first 4 bytes
  const hashInt =
    (hashBytes[0] << 24) |
    (hashBytes[1] << 16) |
    (hashBytes[2] << 8) |
    hashBytes[3];
  const absHash = Math.abs(hashInt);

  const totalWeight = variants.reduce((sum, v) => sum + v.traffic_weight, 0);
  const bucket = absHash % totalWeight;

  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.traffic_weight;
    if (bucket < cumulative) return variant;
  }
  return variants[0];
}
