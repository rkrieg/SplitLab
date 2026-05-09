import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUserPlan, getMonthlyVisitorCount, getActiveTestCount, getClientCount, getTeamSeatCount } from '@/lib/planLimits';
import { getPlan, formatLimit } from '@/lib/plans';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;
  const planId = await getUserPlan(userId);
  const limits = getPlan(planId);

  const [visitors, tests, clients, seats] = await Promise.all([
    getMonthlyVisitorCount(userId),
    getActiveTestCount(userId),
    getClientCount(userId),
    getTeamSeatCount(),
  ]);

  const visitorPct = limits.monthlyVisitors === Infinity ? 0 : Math.round((visitors / limits.monthlyVisitors) * 100);

  return NextResponse.json({
    plan: planId,
    planName: limits.name,
    visitors: {
      used: visitors,
      limit: limits.monthlyVisitors,
      pct: visitorPct,
      limitLabel: formatLimit(limits.monthlyVisitors),
    },
    tests: {
      used: tests,
      limit: limits.maxActiveTests,
      pct: limits.maxActiveTests === Infinity ? 0 : Math.round((tests / limits.maxActiveTests) * 100),
      limitLabel: formatLimit(limits.maxActiveTests),
    },
    clients: {
      used: clients,
      limit: limits.maxClients,
      pct: limits.maxClients === Infinity ? 0 : Math.round((clients / limits.maxClients) * 100),
      limitLabel: formatLimit(limits.maxClients),
    },
    seats: {
      used: seats,
      limit: limits.maxTeamSeats,
      pct: limits.maxTeamSeats === Infinity ? 0 : Math.round((seats / limits.maxTeamSeats) * 100),
      limitLabel: formatLimit(limits.maxTeamSeats),
    },
  });
}
