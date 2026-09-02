import { db } from '@/lib/supabase-server';

/**
 * ROLES
 *
 * admin   — Platform staff only. Manually assigned, never given on signup.
 *           Sees and controls everything across all client accounts.
 *
 * manager — Assigned automatically to every self-signup (free or paid).
 *           Sees owned clients plus any clients/workspaces they were invited to.
 *           Can create/delete owned clients, invite viewers to their workspaces.
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
 * Resolves the account owner (id + plan) for a workspace, tracing
 * workspace → client → owner. AI usage/billing attaches to the owner, not the
 * invited member making the call. Returns null owner on any lookup failure.
 */
export async function resolveWorkspaceOwner(
  workspaceId: string
): Promise<{ ownerId: string | null; plan: string; ownerName: string | null }> {
  const { data: ws } = await db
    .from('workspaces')
    .select('client_id')
    .eq('id', workspaceId)
    .single();
  if (!ws) return { ownerId: null, plan: 'free', ownerName: null };

  const { data: client } = await db
    .from('clients')
    .select('owner_id')
    .eq('id', ws.client_id)
    .single();
  if (!client?.owner_id) return { ownerId: null, plan: 'free', ownerName: null };

  const { data: owner } = await db
    .from('users')
    .select('plan, name, email')
    .eq('id', client.owner_id)
    .single();

  return {
    ownerId: client.owner_id,
    plan: owner?.plan ?? 'free',
    // Shown in the editor when the person working is not the person billed, so
    // they know whose credits are draining and who to ask for more.
    ownerName: owner?.name ?? owner?.email ?? null,
  };
}

/**
 * The account AI usage in this workspace is billed to, plus whether the caller
 * is allowed to spend on it.
 *
 * AI credits are charged to the client owner, never to the person making the
 * call — an invited team member editing a client's page drains the owner's
 * balance. So the credit meter, the top-up checkout and the overage toggle all
 * have to be resolved against the owner too, or they read and write an account
 * that has nothing to do with the work being done.
 *
 * `canManage` is the separate question of whether the caller may commit money
 * to that account. Viewing the balance is information an invited member needs
 * to do their job; buying credits or turning on overage billing is a charge on
 * somebody else's card, so only the owner (or platform staff) may do it.
 *
 * DEFERRED (Renny, Slack 2026-09-03): letting owners delegate this to a team
 * member. Agreed in principle, parked to keep the billing fixes small. Note the
 * ask was "make them admins" — that must NOT be done through users.role, which
 * means SplitLab staff and grants manager access to every workspace on the
 * platform plus /admin. The scoped version is a `can_manage_billing` flag on
 * workspace_members, read here alongside `isSelf`; it needs a migration and a
 * toggle on the Team page, which is why it is not in this pass.
 *
 * Returns null when the caller has no access to the workspace at all.
 */
export async function resolveAiBillingAccount(
  workspaceId: string,
  userId: string,
  userRole: string
): Promise<{ ownerId: string; plan: string; ownerName: string | null; isSelf: boolean; canManage: boolean } | null> {
  const role = await resolveWorkspaceRole(workspaceId, userId, userRole);
  if (!role) return null;

  const { ownerId, plan, ownerName } = await resolveWorkspaceOwner(workspaceId);
  if (!ownerId) return null;

  const isSelf = ownerId === userId;
  return { ownerId, plan, ownerName, isSelf, canManage: isSelf || userRole === 'admin' };
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

/**
 * Client IDs the user can see in global lists / dashboard.
 * Admins should not use this — they see everything.
 * Managers: owned clients ∪ clients reached via workspace_members.
 * Viewers: membership clients only.
 */
export async function getAccessibleClientIds(
  userId: string,
  userRole: string,
  opts?: { activeOnly?: boolean }
): Promise<string[]> {
  if (userRole === 'admin') return []; // callers should short-circuit admins

  let memberClientIds = await clientIdsFromMemberships(userId);
  if (opts?.activeOnly && memberClientIds.length > 0) {
    const { data: activeMembers } = await db
      .from('clients')
      .select('id')
      .in('id', memberClientIds)
      .eq('status', 'active');
    memberClientIds = activeMembers?.map((c) => c.id) ?? [];
  }

  if (userRole === 'viewer') return memberClientIds;

  let ownedQuery = db.from('clients').select('id').eq('owner_id', userId);
  if (opts?.activeOnly) ownedQuery = ownedQuery.eq('status', 'active');
  const { data: owned } = await ownedQuery;

  return Array.from(new Set([...(owned?.map((c) => c.id) ?? []), ...memberClientIds]));
}

/**
 * Workspace IDs the user can see in global pages/scripts lists.
 * Managers: all workspaces under owned clients ∪ explicit memberships.
 * Viewers: membership workspaces only.
 */
export async function getAccessibleWorkspaceIds(
  userId: string,
  userRole: string
): Promise<string[]> {
  if (userRole === 'admin') return []; // callers should short-circuit admins

  const { data: memberships } = await db
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId);
  const memberWsIds = memberships?.map((m) => m.workspace_id) ?? [];

  if (userRole === 'viewer') return memberWsIds;

  const { data: ownedClients } = await db
    .from('clients')
    .select('id')
    .eq('owner_id', userId);
  const ownedClientIds = ownedClients?.map((c) => c.id) ?? [];

  let ownedWsIds: string[] = [];
  if (ownedClientIds.length > 0) {
    const { data: workspaces } = await db
      .from('workspaces')
      .select('id')
      .in('client_id', ownedClientIds);
    ownedWsIds = workspaces?.map((w) => w.id) ?? [];
  }

  return Array.from(new Set([...ownedWsIds, ...memberWsIds]));
}

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
