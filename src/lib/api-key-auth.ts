import crypto from 'crypto';
import { extractBearerToken } from '@/lib/mcp/auth';

/**
 * Auth for the public-reachable, key-gated reporting API (/api/v1/*).
 *
 * NOT the same thing as middleware's PUBLIC_PATHS (/api/event, /api/form-leads,
 * /tracker.js). Those take no credential at all because a visitor's browser has
 * to call them. This one is reachable from anywhere but returns 401 without a
 * key.
 *
 * ── The v1 model, and why it looks like this ──────────────────────────────
 * Today there is exactly one key, in INTERNAL_API_KEY, and it can read every
 * client. That is a deliberate v1 for an internal consumer, not the end state:
 * the whole point of routing every caller through resolveApiPrincipal() is that
 * when per-user keys arrive (an `api_keys` table, hashed the way MCP tokens
 * already are in src/lib/mcp/tokens.ts), ONLY THIS FUNCTION CHANGES. It starts
 * returning { clientIds: [...] } from getAccessibleClientIds(userId, role) —
 * the same function the dashboard already uses — and the route, the RPC, the
 * cursor and the response shape all stay exactly as they are.
 *
 * Until then, treat the env key as what it is: a credential with no user behind
 * it that can read every client's contact records. It belongs on a server, not
 * in a browser. The route ships no CORS headers precisely so that a browser
 * cannot be the thing holding it.
 */
export interface ApiPrincipal {
  /** Client IDs this caller may read, or 'all' for the unscoped internal key. */
  clientIds: string[] | 'all';
  /** Rate-limit bucket and log label. Never the key itself. */
  keyId: string;
}

/**
 * ONE env var, deliberately: INTERNAL_API_KEY, holding whatever key belongs to
 * THIS deployment. Staging and production each define their own value, so a
 * leaked staging key cannot read production leads.
 *
 * That separation only holds because the name is the same everywhere and the
 * value differs. Do not add a second name (…_PROD, …_STAGING) that a single
 * deployment could define alongside this one — the moment production also
 * accepts the staging key, every staging key holder can read every client's
 * contact records, and nothing here could tell the difference.
 */
const KEY_ENV_VAR = 'INTERNAL_API_KEY';

/**
 * Constant-time compare. A plain === leaks the length of the shared prefix
 * through timing, which is enough to recover a key one character at a time
 * given sufficient requests — cheap to avoid, so avoid it.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal. Hash both sides first so the comparison is always 32 bytes.
  const ah = crypto.createHash('sha256').update(ab).digest();
  const bh = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/**
 * Resolves an incoming request into a principal, or null if unauthenticated.
 *
 * Fails CLOSED when no key is configured: a deploy that forgot the env var
 * must reject every request, never accidentally serve every client's leads to
 * anyone who finds the URL. Keys under 16 characters are ignored as unset —
 * that rules out a placeholder or a half-pasted value acting as a credential.
 */
export function resolveApiPrincipal(authHeader: string | null): ApiPrincipal | null {
  const configured = process.env[KEY_ENV_VAR]?.trim();
  if (!configured || configured.length < 16) return null;

  const presented = extractBearerToken(authHeader);
  if (!presented) return null;

  if (!safeEqual(presented, configured)) return null;

  return {
    clientIds: 'all',
    // Fixed bucket name — there is only one key. Never the key itself: this id
    // ends up in rate-limit maps and log lines.
    keyId: 'internal',
  };
}
