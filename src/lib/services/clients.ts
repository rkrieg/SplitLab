import { db } from '@/lib/supabase-server';
import { ok, ServiceResult } from './types';

const CLIENT_SELECT = `
  *,
  workspaces (
    id, name, slug, status,
    tests ( id, status )
  )
`;

/** Client IDs the user can reach via workspace_members (owned or invited). */
async function clientIdsFromMemberships(userId: string): Promise<string[]> {
  const { data: memberships } = await db
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId);

  const workspaceIds = memberships?.map((m) => m.workspace_id) ?? [];
  if (workspaceIds.length === 0) return [];

  const { data: workspaces } = await db
    .from('workspaces')
    .select('client_id')
    .in('id', workspaceIds);

  return Array.from(new Set(workspaces?.map((w) => w.client_id) ?? []));
}

/**
 * Clients visible to a user, replicating GET /api/clients exactly (including
 * the admin-sees-everything special case) — reused by list_clients MCP tool
 * so an admin's connected Claude session sees the same thing the dashboard
 * shows them, not an empty list from a naive getAccessibleClientIds() call.
 */
export async function listClientsForUser(userId: string, role: string): Promise<ServiceResult<unknown[]>> {
  // TEMP: verifying both GET /api/clients and the MCP list_clients tool hit
  // this same function — remove once confirmed.
  console.log('[listClientsForUser] called with', { userId, role });

  if (role === 'admin') {
    const { data, error } = await db
      .from('clients')
      .select(CLIENT_SELECT)
      .order('created_at', { ascending: false });
    if (error) return { ok: false, status: 500, error: error.message };
    return ok(data ?? []);
  }

  if (role === 'manager') {
    const { data: owned, error: ownedError } = await db
      .from('clients')
      .select('id')
      .eq('owner_id', userId);
    if (ownedError) return { ok: false, status: 500, error: ownedError.message };

    const memberClientIds = await clientIdsFromMemberships(userId);
    const clientIds = Array.from(new Set([...(owned?.map((c) => c.id) ?? []), ...memberClientIds]));
    if (clientIds.length === 0) return ok([]);

    const { data, error } = await db
      .from('clients')
      .select(CLIENT_SELECT)
      .in('id', clientIds)
      .order('created_at', { ascending: false });
    if (error) return { ok: false, status: 500, error: error.message };
    return ok(data ?? []);
  }

  // viewer: only clients they have workspace membership in
  const clientIds = await clientIdsFromMemberships(userId);
  if (clientIds.length === 0) return ok([]);

  const { data, error } = await db
    .from('clients')
    .select(CLIENT_SELECT)
    .in('id', clientIds)
    .order('created_at', { ascending: false });

  if (error) return { ok: false, status: 500, error: error.message };
  return ok(data ?? []);
}
