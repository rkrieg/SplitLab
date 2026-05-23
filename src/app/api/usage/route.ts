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

  const isUnlimitedTests   = limits.maxActiveTests === Infinity;
  const isUnlimitedClients = limits.maxClients === Infinity;

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
  });
}
