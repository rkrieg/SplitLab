import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import BillingClient from './BillingClient';

export default async function BillingPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/login');

  let plan              = 'free';
  let status            = 'active';
  let hasStripeCustomer = false;
  let currentPeriodEnd: string | null = null;

  try {
    const { data: user } = await db
      .from('users')
      .select('plan, stripe_customer_id, subscription_status, subscription_current_period_end')
      .eq('id', session.user.id)
      .single();

    const u = user as {
      plan?: string;
      stripe_customer_id?: string | null;
      subscription_status?: string;
      subscription_current_period_end?: string | null;
    } | null;

    plan              = u?.plan              ?? 'free';
    status            = u?.subscription_status ?? 'active';
    hasStripeCustomer = !!u?.stripe_customer_id;
    currentPeriodEnd  = u?.subscription_current_period_end ?? null;
  } catch (err) {
    console.error('[billing-page] DB error:', err);
  }

  return (
    <div>
      <Header title="Billing" subtitle="Manage your plan, usage, and subscription" />
      <div className="p-6">
        <BillingClient
          initialPlan={plan}
          initialStatus={status}
          hasStripeCustomer={hasStripeCustomer}
          isAdmin={session.user.role === 'admin'}
          currentPeriodEnd={currentPeriodEnd}
        />
      </div>
    </div>
  );
}
