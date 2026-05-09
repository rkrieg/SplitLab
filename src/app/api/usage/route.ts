import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUserPlan, getMonthlyVisitorCount, getActiveTestCount, getClientCount, getTeamSeatCount } from '@/lib/planLimits';
import { getPlan, formatLimit } from '@/lib/plans';

export const dynamic = 'force-dynamic';

// JSON cannot represent Infinity — use a sentinel value the client can detect
const serializeLimit = (val: number) => val === Infinity ? null : val;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;
  const planId = await getUserPlan(userId);
  const limits = getPlan(planId);

  const [visitors, tests, clients, seats] = await Promise.all([
    getMonthlyVisitorCount(userId),
    getActiveTestCount(userId),
    getClientCount(userId),
    getTeamSeatCount(),
  ]);

  const isUnlimitedVisitors = limits.monthlyVisitors === Infinity;
  const isUnlimitedTests = limits.maxActiveTests === Infinity;
  const isUnlimitedClients = limits.maxClients === Infinity;
  const isUnlimitedSeats = limits.maxTeamSeats === Infinity;

  return NextResponse.json({
    plan: planId,
    planName: limits.name,
    visitors: {
      used: visitors,
      limit: serializeLimit(limits.monthlyVisitors),
      pct: isUnlimitedVisitors ? 0 : Math.round((visitors / limits.monthlyVisitors) * 100),
      limitLabel: formatLimit(limits.monthlyVisitors),
    },
    tests: {
      used: tests,
      limit: serializeLimit(limits.maxActiveTests),
      pct: isUnlimitedTests ? 0 : Math.round((tests / limits.maxActiveTests) * 100),
      limitLabel: formatLimit(limits.maxActiveTests),
    },
    clients: {
      used: clients,
      limit: serializeLimit(limits.maxClients),
      pct: isUnlimitedClients ? 0 : Math.round((clients / limits.maxClients) * 100),
      limitLabel: formatLimit(limits.maxClients),
    },
    seats: {
      used: seats,
      limit: serializeLimit(limits.maxTeamSeats),
      pct: isUnlimitedSeats ? 0 : Math.round((seats / limits.maxTeamSeats) * 100),
      limitLabel: formatLimit(limits.maxTeamSeats),
    },
  });
}
