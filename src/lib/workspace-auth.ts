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
  // CHECK 1 — Is this person SplitLab staff (admin)? This is stored on their
  // own account and has nothing to do with the workspace. Admins always pass.
  if (userRole === 'admin') return 'manager';

  // CHECK 2 — Find out which CLIENT owns this workspace.
  const { data: workspace } = await db
    .from('workspaces')
    .select('client_id')
    .eq('id', workspaceId)
    .single();

  if (workspace) {
    // CHECK 3 — Did THIS user create that client themselves (are they the owner)?
    const { data: owned } = await db
      .from('clients')
      .select('id')
      .eq('id', workspace.client_id)
      .eq('owner_id', userId)
      .single();

    // They made it themselves — full access, done.
    if (owned) return 'manager';
  }

  // CHECK 4 — Not admin, not the owner. Was this user specifically invited
  // to this exact workspace? Look for a row matching BOTH this workspace AND
  // this user — not just "is this user a member of something somewhere."
  const { data: member } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single();

  // If invited, return whatever role they were given ('manager' or 'viewer').
  // If none of the 4 checks matched at all, return null — this user has no
  // relationship to this workspace whatsoever.
  return (member?.role as 'manager' | 'viewer') ?? null;
}

/**
 * Resolves the plan of the account owner for a given workspace.
 * Always traces workspace → client → owner → users.plan so that invited
 * managers (whose own plan row is 'free') are correctly evaluated against
 * the workspace owner's plan — the same pattern used by the domains gate.
 *
 * Returns 'free' as a safe fallback on any lookup failure.
 */
export async function resolveOwnerPlan(workspaceId: string): Promise<string> {
  const { data: ws } = await db
    .from('workspaces')
    .select('client_id')
    .eq('id', workspaceId)
    .single();

  if (!ws) return 'free';

  const { data: client } = await db
    .from('clients')
    .select('owner_id')
    .eq('id', ws.client_id)
    .single();

  if (!client?.owner_id) return 'free';

  const { data: owner } = await db
    .from('users')
    .select('plan')
    .eq('id', client.owner_id)
    .single();

  return owner?.plan ?? 'free';
}

/**
 * Convenience wrapper for routes keyed off a test ID.
 * Returns null if the test doesn't exist; otherwise returns the workspace_id
 * and the caller's effective role for that workspace.
 */
export async function resolveTestWorkspaceRole(
  testId: string,
  userId: string,
  userRole: string
): Promise<{ workspaceId: string; role: 'manager' | 'viewer' | null } | null> {
  const { data: test } = await db.from('tests').select('workspace_id').eq('id', testId).single();
  if (!test) return null;
  const role = await resolveWorkspaceRole(test.workspace_id, userId, userRole);
  return { workspaceId: test.workspace_id, role };
}
