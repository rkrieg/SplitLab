import { db } from '@/lib/supabase-server';

/**
 * ROLES
 *
 * admin   — Platform staff only. Manually assigned, never given on signup.
 *           Sees and controls everything across all client accounts.
 *
 * manager — Assigned automatically to every self-signup (free or paid).
 *           Sees only their own clients, pages, scripts, tests, and stats.
 *           Can create/delete clients, invite viewers to their workspaces.
 *
 * viewer  — Assigned when a manager invites a team member.
 *           Scoped to the specific workspaces they were invited to.
 *           Read-only: cannot create or delete anything.
 *
 * NOTE: Plans (Free/Pro/Agency/Scale) do NOT change role — they only control
 * limits (number of clients, tests, etc.), not what the user is allowed to see.
 * 
 * Key rule: Plans (Free/Pro/Agency/Scale) do not change your role. A paid manager is still a manager — plans only control limits like number of clients or tests, not what you're allowed to see
 */

/**
 * Resolves the effective role a user has for a given workspace.
 * Returns 'manager' | 'viewer', or null if no access.
 *
 * Access is granted if the user is:
 *   1. A platform admin (userRole === 'admin')
 *   2. The owner of the client that contains this workspace
 *   3. An explicit workspace_members entry
 */
export async function resolveWorkspaceRole(
  workspaceId: string,
  userId: string,
  userRole: string
): Promise<'manager' | 'viewer' | null> {
  if (userRole === 'admin') return 'manager';

  const { data: workspace } = await db
    .from('workspaces')
    .select('client_id')
    .eq('id', workspaceId)
    .single();

  if (workspace) {
    const { data: owned } = await db
      .from('clients')
      .select('id')
      .eq('id', workspace.client_id)
      .eq('owner_id', userId)
      .single();

    if (owned) return 'manager';
  }

  const { data: member } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single();

  return (member?.role as 'manager' | 'viewer') ?? null;
}
