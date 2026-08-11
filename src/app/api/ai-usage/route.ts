import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { getAiUsageSummary } from '@/lib/ai-usage';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const overageSchema = z.object({
  enabled:      z.boolean().optional(),
  capCents:     z.number().int().min(0).max(500_000).optional(),   // $0–$5,000 ceiling
  notifyCents:  z.number().int().min(500).max(500_000).optional(), // warn increment, min $5
});

// AI usage summary for the logged-in account owner — powers the credit meter
// on the Billing page. Overage settings are returned alongside so the UI can
// show the spend cap and whether overage is enabled.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: user } = await db
    .from('users')
    .select('plan, ai_overage_enabled, ai_overage_cap_cents, ai_overage_notify_cents')
    .eq('id', session.user.id)
    .single();

  const plan = user?.plan ?? session.user.plan ?? 'free';
  const summary = await getAiUsageSummary(session.user.id, plan);

  return NextResponse.json({
    ...summary,
    overage: {
      enabled:       user?.ai_overage_enabled ?? false,
      capCents:      user?.ai_overage_cap_cents ?? 5000,
      notifyCents:   user?.ai_overage_notify_cents ?? 5000,
    },
  });
}

// Update the account owner's overage settings (enable/disable, spend cap,
// notify increment). The spend cap is the hard ceiling that pauses AI even
// with overage on — the Lovable/Replit-style guard against surprise bills.
export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let data: z.infer<typeof overageSchema>;
  try {
    data = overageSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid settings' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (data.enabled !== undefined)     updates.ai_overage_enabled     = data.enabled;
  if (data.capCents !== undefined)    updates.ai_overage_cap_cents    = data.capCents;
  if (data.notifyCents !== undefined) updates.ai_overage_notify_cents = data.notifyCents;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { error } = await db.from('users').update(updates as never).eq('id', session.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
