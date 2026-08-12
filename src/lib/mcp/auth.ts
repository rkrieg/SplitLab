import { db } from '@/lib/supabase-server';
import { hashToken } from './tokens';
import type { UserRole } from '@/types';

export interface McpPrincipal {
  id: string;
  role: UserRole;
  plan: string;
  scope: string;
  tokenId: string;
}

/**
 * Resolves a Bearer access token into the same {id, role, plan} shape
 * session.user already carries from NextAuth (see src/lib/auth.ts). This is
 * the linchpin of the whole MCP auth model: every tool handler calls this,
 * then feeds principal.id/principal.role straight into the existing
 * resolveWorkspaceRole / getAccessibleClientIds / resolveTestWorkspaceRole
 * (src/lib/workspace-auth.ts) UNMODIFIED. There is no parallel authorization
 * model — a viewer connecting Claude is exactly as restricted as a viewer
 * clicking through the dashboard, because it's the same function with the
 * same arguments.
 */
export async function resolveMcpPrincipal(bearerToken: string | null): Promise<McpPrincipal | null> {
  if (!bearerToken) return null;
  const tokenHash = hashToken(bearerToken);

  const { data: tokenRow } = await db
    .from('oauth_tokens')
    .select('id, user_id, scope, expires_at, revoked_at')
    .eq('access_token_hash', tokenHash)
    .single();

  if (!tokenRow) return null;
  if (tokenRow.revoked_at) return null;
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) return null;

  const { data: user } = await db
    .from('users')
    .select('id, role, plan, status')
    .eq('id', tokenRow.user_id)
    .single();

  if (!user || user.status !== 'active') return null;

  // Best-effort last-used stamp — never block the request on it.
  db.from('oauth_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', tokenRow.id);

  return {
    id: user.id,
    role: user.role as UserRole,
    plan: (user.plan as string) ?? 'free',
    scope: tokenRow.scope ?? '',
    tokenId: tokenRow.id,
  };
}

/**
 * OAuth scope is an ADDITIONAL ceiling on top of the existing role model,
 * never a replacement for it. A write-scoped token from a viewer user must
 * still be rejected by resolveWorkspaceRole returning 'viewer' — check both.
 */
export function principalHasWriteScope(principal: McpPrincipal): boolean {
  return principal.scope.split(' ').includes('splitlab:write');
}

/** Extracts "Bearer xxx" from an Authorization header, or null. */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
