import { rawQuery } from '@/lib/db';
import { PLANS, getPlan, currentMonth, type PlanId } from '@/lib/plans';
import { NextResponse } from 'next/server';

export async function getUserPlan(userId: string): Promise<PlanId> {
  const rows = await rawQuery<{ plan: string }>(
    'SELECT plan FROM users WHERE id = $1',
    [userId]
  );
  const plan = rows[0]?.plan ?? 'starter';
  return (plan in PLANS ? plan : 'starter') as PlanId;
}

export async function getActiveTestCount(userId: string): Promise<number> {
  const rows = await rawQuery<{ count: string }>(
    `SELECT COUNT(DISTINCT t.id)::text AS count
     FROM tests t
     JOIN workspaces w ON t.workspace_id = w.id
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = $1
       AND t.status IN ('draft','running','paused')`,
    [userId]
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

export async function getClientCount(userId: string): Promise<number> {
  const rows = await rawQuery<{ count: string }>(
    `SELECT COUNT(DISTINCT c.id)::text AS count
     FROM clients c
     JOIN workspaces w ON w.client_id = c.id
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = $1`,
    [userId]
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

export async function getTeamSeatCount(): Promise<number> {
  const rows = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM users WHERE status != 'deleted'`,
    []
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

export async function getMonthlyVisitorCount(userId: string): Promise<number> {
  const month = currentMonth();
  const rows = await rawQuery<{ visitor_count: string }>(
    `SELECT visitor_count FROM visitor_usage WHERE user_id = $1 AND month = $2`,
    [userId, month]
  );
  return parseInt(rows[0]?.visitor_count ?? '0', 10);
}

// Returns the admin user_id for a given workspace (for billing purposes)
export async function getWorkspaceOwner(workspaceId: string): Promise<string | null> {
  const rows = await rawQuery<{ user_id: string }>(
    `SELECT wm.user_id
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1
       AND u.role = 'admin'
     ORDER BY wm.created_at ASC
     LIMIT 1`,
    [workspaceId]
  );
  return rows[0]?.user_id ?? null;
}

// Atomically increment visitor count for a user for the current month.
// Returns the new count.
export async function incrementVisitorCount(userId: string): Promise<number> {
  const month = currentMonth();
  const rows = await rawQuery<{ visitor_count: number }>(
    `INSERT INTO visitor_usage (user_id, month, visitor_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, month)
     DO UPDATE SET visitor_count = visitor_usage.visitor_count + 1
     RETURNING visitor_count`,
    [userId, month]
  );
  return rows[0]?.visitor_count ?? 1;
}

// Check if visitor limit is exceeded for a workspace's owner.
// Returns { allowed, pct, used, limit } — fast single-row lookup.
export async function checkVisitorLimitForWorkspace(workspaceId: string): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  pct: number;
  userId: string | null;
  planId: PlanId;
}> {
  const userId = await getWorkspaceOwner(workspaceId);
  if (!userId) return { allowed: true, used: 0, limit: Infinity, pct: 0, userId: null, planId: 'starter' };

  const planId = await getUserPlan(userId);
  const limits = getPlan(planId);
  if (limits.monthlyVisitors === Infinity) {
    return { allowed: true, used: 0, limit: Infinity, pct: 0, userId, planId };
  }

  const used = await getMonthlyVisitorCount(userId);
  const pct = Math.round((used / limits.monthlyVisitors) * 100);
  return {
    allowed: used < limits.monthlyVisitors,
    used,
    limit: limits.monthlyVisitors,
    pct,
    userId,
    planId,
  };
}

// Fire warning emails + update DB if threshold crossed (70% or 90% or 100%).
// Called after incrementing visitor count (non-blocking — fire and forget is fine).
export async function maybeSendVisitorWarning(
  userId: string,
  used: number,
  limit: number,
  appUrl: string
): Promise<void> {
  if (limit === Infinity) return;
  const pct = Math.round((used / limit) * 100);
  const newLevel = pct >= 100 ? 100 : pct >= 90 ? 90 : pct >= 70 ? 70 : 0;
  if (newLevel === 0) return;

  const month = currentMonth();

  // Check current warning state
  const rows = await rawQuery<{ visitor_warning_level: number; visitor_warning_month: string | null; email: string; name: string; plan: string }>(
    `SELECT visitor_warning_level, visitor_warning_month, email, name, COALESCE(plan, 'starter') AS plan
     FROM users WHERE id = $1`,
    [userId]
  );
  const user = rows[0];
  if (!user) return;

  // Only send if: this is a new/higher threshold OR a new month
  const alreadySentThisMonth = user.visitor_warning_month === month && user.visitor_warning_level >= newLevel;
  if (alreadySentThisMonth) return;

  // Update warning level
  await rawQuery(
    `UPDATE users SET visitor_warning_level = $1, visitor_warning_month = $2 WHERE id = $3`,
    [newLevel, month, userId]
  );

  // Send the appropriate email (don't await so serve stays fast)
  const planName = getPlan(user.plan).name;
  try {
    if (newLevel >= 100) {
      const { sendVisitorLimitReachedEmail } = await import('@/lib/email');
      await sendVisitorLimitReachedEmail({ toEmail: user.email, toName: user.name, limit, planName, dashboardUrl: appUrl });
    } else {
      const { sendVisitorWarningEmail } = await import('@/lib/email');
      await sendVisitorWarningEmail({ toEmail: user.email, toName: user.name, used, limit, pct: newLevel, planName, dashboardUrl: appUrl });
    }
  } catch (err) {
    console.error('[visitor-warning] email failed:', err);
  }
}

export interface LimitCheckResult {
  allowed: boolean;
  current: number;
  max: number;
  plan: PlanId;
  planName: string;
  limitType: string;
  response?: NextResponse;
}

export async function checkTestLimit(userId: string): Promise<LimitCheckResult> {
  const planId = await getUserPlan(userId);
  const limits = getPlan(planId);
  const current = await getActiveTestCount(userId);
  const allowed = current < limits.maxActiveTests;
  return {
    allowed,
    current,
    max: limits.maxActiveTests,
    plan: planId,
    planName: limits.name,
    limitType: 'active_tests',
    response: allowed
      ? undefined
      : NextResponse.json(
          {
            error: 'plan_limit_exceeded',
            limitType: 'active_tests',
            current,
            max: limits.maxActiveTests,
            plan: planId,
            planName: limits.name,
            message: `Your ${limits.name} plan allows ${limits.maxActiveTests} active test${limits.maxActiveTests === 1 ? '' : 's'}. You currently have ${current}.`,
          },
          { status: 403 }
        ),
  };
}

export async function checkClientLimit(userId: string): Promise<LimitCheckResult> {
  const planId = await getUserPlan(userId);
  const limits = getPlan(planId);
  const current = await getClientCount(userId);
  const allowed = current < limits.maxClients;
  return {
    allowed,
    current,
    max: limits.maxClients,
    plan: planId,
    planName: limits.name,
    limitType: 'clients',
    response: allowed
      ? undefined
      : NextResponse.json(
          {
            error: 'plan_limit_exceeded',
            limitType: 'clients',
            current,
            max: limits.maxClients,
            plan: planId,
            planName: limits.name,
            message: `Your ${limits.name} plan allows ${limits.maxClients} client${limits.maxClients === 1 ? '' : 's'}. You currently have ${current}.`,
          },
          { status: 403 }
        ),
  };
}

export async function checkTeamSeatLimit(userId: string): Promise<LimitCheckResult> {
  const planId = await getUserPlan(userId);
  const limits = getPlan(planId);
  const current = await getTeamSeatCount();
  const allowed = limits.maxTeamSeats === Infinity || current < limits.maxTeamSeats;
  return {
    allowed,
    current,
    max: limits.maxTeamSeats,
    plan: planId,
    planName: limits.name,
    limitType: 'team_seats',
    response: allowed
      ? undefined
      : NextResponse.json(
          {
            error: 'plan_limit_exceeded',
            limitType: 'team_seats',
            current,
            max: limits.maxTeamSeats,
            plan: planId,
            planName: limits.name,
            message: `Your ${limits.name} plan allows ${limits.maxTeamSeats} team seat${limits.maxTeamSeats === 1 ? '' : 's'}. Upgrade to invite more members.`,
          },
          { status: 403 }
        ),
  };
}
