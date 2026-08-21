import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { logEvent } from '@/lib/log';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const PLANS = ['free', 'pro', 'growth', 'agency', 'scale'] as const;
const schema = z.object({ plan: z.enum(PLANS) });

// Admin override of a user's plan. This sets users.plan directly (a comp /
// manual change) and does NOT create or modify a Stripe subscription — use it
// for comps, support fixes, and internal accounts. For a real billed change the
// customer goes through Stripe checkout / the portal.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Require a real admin (not an impersonated session).
  if (session.user.role !== 'admin' || session.user.impersonatorId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
  }

  const { data: before } = await db.from('users').select('plan, email').eq('id', params.id).single();
  if (!before) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const { error } = await db.from('users').update({ plan: data.plan } as never).eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  void logEvent('admin_action', 'info', 'change_plan', {
    adminId: session.user.id, targetId: params.id, targetEmail: before.email,
    from: before.plan, to: data.plan,
  });

  return NextResponse.json({ ok: true, plan: data.plan });
}
