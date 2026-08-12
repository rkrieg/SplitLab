import crypto from 'crypto';

/** Random opaque token with a readable prefix, e.g. mcp_at_xxxx (access), mcp_rt_xxxx (refresh). */
export function generateToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

export function generateClientId(): string {
  return `mcp_${crypto.randomBytes(12).toString('base64url')}`;
}

export function generateAuthCode(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** Tokens/codes/secrets are stored as hashes only — same convention as users.password_hash. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** PKCE S256 verification: base64url(sha256(code_verifier)) === code_challenge. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}
