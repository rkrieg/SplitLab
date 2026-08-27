/**
 * Minimal per-token rate limit for the MCP surface. No rate-limiting
 * infrastructure exists elsewhere in the codebase for /api/* routes
 * generally (grepped for "rate.limit"/"ratelimit" — nothing found), so this
 * is a new, narrowly-scoped gap-closer: a looping/misbehaving AI agent can
 * generate far more request volume than a human clicking through the UI.
 *
 * In-memory only — fine for a single server instance; on multi-instance
 * deployment this under-counts (each instance has its own bucket), which
 * only makes the limit MORE permissive, never less safe. Revisit with a
 * DB/Redis-backed counter if that gap matters before Phase 1 ships broadly.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;

const buckets = new Map<string, { count: number; windowStart: number }>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export function checkMcpRateLimit(tokenId: string): RateLimitResult {
  return checkRateLimit(`mcp:${tokenId}`, MAX_REQUESTS_PER_WINDOW);
}

/**
 * Same fixed-window bucket, reusable by any credentialed surface — the v1
 * reporting API (/api/v1/*) shares it rather than standing up a second copy
 * of the same Map. Buckets are namespaced by the caller's prefix so an MCP
 * token and an API key can never collide on one counter.
 *
 * Same caveat as above: in-memory, so multi-instance deploys under-count,
 * which only ever makes the limit more permissive.
 */
export function checkRateLimit(bucketKey: string, max: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(bucketKey);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(bucketKey, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (bucket.count >= max) {
    const retryAfterSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  bucket.count += 1;
  return { allowed: true };
}
