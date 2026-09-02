import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { getAiUsageSummary } from '@/lib/ai-usage';
import { resolveAiBillingAccount } from '@/lib/workspace-auth';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const overageSchema = z.object({
  workspaceId:  z.string().uuid().optional(),
  enabled:      z.boolean().optional(),
  capCents:     z.number().int().min(0).max(500_000).optional(),   // $0–$5,000 ceiling
  notifyCents:  z.number().int().min(500).max(500_000).optional(), // warn increment, min $5
});

/**
 * Which account this request is about.
 *
 * With no workspaceId this is the caller's own account — that is the Billing
 * page, where "your credits" means yours. With a workspaceId it is whichever
 * account that workspace bills to, because AI usage is always charged to the
 * client owner and an invited team member editing a client's page spends the
 * owner's balance, not their own. Reading the caller's account there would show
 * a meter that never moves while credits drain somewhere else.
 */
async function resolveTarget(
  session: { user: { id: string; role: string; plan?: string | null } },
  workspaceId: string | null,
): Promise<
  | { ok: true; ownerId: string; plan: string; ownerName: string | null; isSelf: boolean; canManage: boolean }
  | { ok: false; status: number; error: string }
> {
  if (workspaceId) {
    const acct = await resolveAiBillingAccount(workspaceId, session.user.id, session.user.role);
    if (!acct) return { ok: false, status: 403, error: 'No access to this workspace' };
    return { ok: true, ...acct };
  }

  const { data: user } = await db.from('users').select('plan').eq('id', session.user.id).single();
  return {
    ok: true,
    ownerId: session.user.id,
    plan: user?.plan ?? session.user.plan ?? 'free',
    ownerName: null,
    isSelf: true,
    canManage: true,
  };
}

// AI usage summary for the account that gets billed — the caller's own on the
// Billing page, the client owner's when a workspace is named. Powers the credit
// meter on Billing and in the page builder. Overage settings ride along so the
// UI can show the spend cap and whether overage is enabled.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  const target = await resolveTarget(session, workspaceId);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });

  const { data: owner } = await db
    .from('users')
    .select('ai_overage_enabled, ai_overage_cap_cents, ai_overage_notify_cents')
    .eq('id', target.ownerId)
    .single();

  const summary = await getAiUsageSummary(target.ownerId, target.plan);

  return NextResponse.json({
    ...summary,
    // Who is actually paying, so the meter can label a balance that is not the
    // viewer's own and the upsell can hide buttons they are not allowed to press.
    owner: {
      isSelf:    target.isSelf,
      name:      target.ownerName,
      canManage: target.canManage,
    },
    overage: {
      enabled:       owner?.ai_overage_enabled ?? false,
      capCents:      owner?.ai_overage_cap_cents ?? 5000,
      notifyCents:   owner?.ai_overage_notify_cents ?? 5000,
    },
  });
}

// Update overage settings (enable/disable, spend cap, notify increment) on the
// billed account. The spend cap is the hard ceiling that pauses AI even with
// overage on — the Lovable/Replit-style guard against surprise bills.
//
// Turning overage on commits the owner to real charges, so an invited team
// member cannot do it on the owner's behalf even though they can see the meter.
// Writing it to the caller's own row instead — which is what this route used to
// do — silently did nothing, because the gate reads the owner's flag.
export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let data: z.infer<typeof overageSchema>;
  try {
    data = overageSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid settings' }, { status: 400 });
  }

  const target = await resolveTarget(session, data.workspaceId ?? null);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });
  if (!target.canManage) {
    return NextResponse.json(
      {
        error: target.ownerName
          ? `Only ${target.ownerName} can change billing for this account.`
          : 'Only the account owner can change billing for this account.',
      },
      { status: 403 },
    );
  }

  const updates: Record<string, unknown> = {};
  if (data.enabled !== undefined)     updates.ai_overage_enabled     = data.enabled;
  if (data.capCents !== undefined)    updates.ai_overage_cap_cents    = data.capCents;
  if (data.notifyCents !== undefined) updates.ai_overage_notify_cents = data.notifyCents;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { error } = await db.from('users').update(updates as never).eq('id', target.ownerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
