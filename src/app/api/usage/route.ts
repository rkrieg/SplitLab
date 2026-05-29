import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { getPlanDetails, formatLimit } from '@/lib/plans';

export const dynamic = 'force-dynamic';

const serialize = (v: number) => (v === Infinity ? null : v);

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  // Get user's plan
  const { data: userRow } = await db
    .from('users')
    .select('plan')
    .eq('id', userId)
    .single();

  const planId  = (userRow as { plan?: string } | null)?.plan ?? 'free';
  const limits  = getPlanDetails(planId);

  // Count active tests across all workspaces this user owns
  const { data: tests } = await db
    .from('tests')
    .select('id, workspace_id, status, workspaces!inner(client_id, clients!inner(owner_id))')
    .not('status', 'eq', 'completed')
    .eq('workspaces.clients.owner_id', userId);

  const testCount = (tests ?? []).length;

  // Count clients owned by this user
  const { data: clients } = await db
    .from('clients')
    .select('id')
    .eq('owner_id', userId);

  const clientCount = (clients ?? []).length;

  // Count unique team members (including owner) across all workspaces owned by this user
  let teamMemberCount = 0;
  if (limits.maxTeamSeats > 0) {
    const { data: workspaces } = await db
      .from('workspaces')
      .select('id')
      .in('client_id', (clients ?? []).map((c) => c.id));

    const workspaceIds = (workspaces ?? []).map((w) => w.id);
    if (workspaceIds.length) {
      const { data: memberRows } = await db
        .from('workspace_members')
        .select('user_id')
        .in('workspace_id', workspaceIds);

      // Count all unique members including the owner
      teamMemberCount = new Set(memberRows?.map((m) => m.user_id)).size;
    }
    // Owner always counts as 1 seat minimum
    if (teamMemberCount === 0) teamMemberCount = 1;
  }

  // Count domains across all workspaces owned by this user
  let domainCount = 0;
  const clientIds = (clients ?? []).map((c) => c.id);
  if (clientIds.length) {
    const { data: workspaces } = await db
      .from('workspaces')
      .select('id')
      .in('client_id', clientIds);

    const wsIds = (workspaces ?? []).map((w) => w.id);
    if (wsIds.length) {
      const { data: domainRows } = await db
        .from('domains')
        .select('id')
        .in('workspace_id', wsIds);
      domainCount = (domainRows ?? []).length;
    }
  }

  const isUnlimitedTests   = limits.maxActiveTests === Infinity;
  const isUnlimitedClients = limits.maxClients === Infinity;
  const isUnlimitedTeam    = limits.maxTeamSeats === Infinity;
  const isUnlimitedDomains = limits.maxDomains === Infinity;

  return NextResponse.json({
    plan:     planId,
    planName: limits.name,
    tests: {
      used:       testCount,
      limit:      serialize(limits.maxActiveTests),
      pct:        isUnlimitedTests ? 0 : Math.round((testCount / limits.maxActiveTests) * 100),
      limitLabel: formatLimit(limits.maxActiveTests),
    },
    clients: {
      used:       clientCount,
      limit:      serialize(limits.maxClients),
      pct:        isUnlimitedClients ? 0 : Math.round((clientCount / limits.maxClients) * 100),
      limitLabel: formatLimit(limits.maxClients),
    },
    // Only included when plan has domains (avoids confusing 0/0 on free plan)
    ...(limits.maxDomains > 0 && {
      domains: {
        used:       domainCount,
        limit:      serialize(limits.maxDomains),
        pct:        isUnlimitedDomains ? 0 : Math.round((domainCount / limits.maxDomains) * 100),
        limitLabel: formatLimit(limits.maxDomains),
      },
    }),
    // Only included when plan has team seats (avoids confusing 0/0 on free plan)
    ...(limits.maxTeamSeats > 0 && {
      teamMembers: {
        used:       teamMemberCount,
        limit:      serialize(limits.maxTeamSeats),
        pct:        isUnlimitedTeam ? 0 : Math.round((teamMemberCount / limits.maxTeamSeats) * 100),
        limitLabel: formatLimit(limits.maxTeamSeats),
      },
    }),
  });
}
