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
  const now = Date.now();
  const bucket = buckets.get(tokenId);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(tokenId, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (bucket.count >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfterSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  bucket.count += 1;
  return { allowed: true };
}
