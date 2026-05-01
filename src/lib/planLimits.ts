import { rawQuery } from '@/lib/db';
import { PLANS, getPlan, type PlanId } from '@/lib/plans';
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

