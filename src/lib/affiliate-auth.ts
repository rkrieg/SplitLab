import crypto from 'crypto';
import type { NextRequest } from 'next/server';

// Lightweight self-contained session for the affiliate portal — kept separate
// from NextAuth (which is for agency staff / the dashboard). A signed cookie
// avoids pulling in a JWT dependency. Node runtime only (uses node:crypto), so
// never verify this in Edge middleware.

export const AFFILIATE_COOKIE = 'sl_affiliate';
const SESSION_DAYS = 30;

function secret(): string {
  return process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || 'dev-insecure-secret';
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** Build a signed session token for an affiliate id. */
export function signAffiliateToken(affiliateId: string): string {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${affiliateId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** Verify a token and return the affiliate id, or null if invalid/expired. */
export function verifyAffiliateToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [affiliateId, expStr, sig] = parts;
  const payload = `${affiliateId}.${expStr}`;

  const expected = sign(payload);
  // Constant-time compare
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return affiliateId;
}

/** Read + verify the affiliate session from a request's cookies. */
export function getAffiliateId(request: NextRequest): string | null {
  return verifyAffiliateToken(request.cookies.get(AFFILIATE_COOKIE)?.value);
}

/** Cookie options for setting the session (matches SESSION_DAYS). */
export const affiliateCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_DAYS * 24 * 60 * 60,
};
