import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { rawQuery } from '@/lib/db';
import Header from '@/components/layout/Header';
import BillingClient from './BillingClient';

export default async function BillingPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const rows = await rawQuery<{
    plan: string;
    stripe_customer_id: string | null;
    subscription_status: string;
  }>(
    'SELECT plan, stripe_customer_id, subscription_status FROM users WHERE id = $1',
    [session.user.id]
  );

  const user = rows[0];
  const plan = user?.plan ?? 'starter';
  const status = user?.subscription_status ?? 'active';
  const hasStripeCustomer = !!user?.stripe_customer_id;

  return (
    <div>
      <Header title="Billing" subtitle="Manage your plan, usage, and subscription" />
      <div className="p-6">
        <BillingClient
          initialPlan={plan}
          initialStatus={status}
          hasStripeCustomer={hasStripeCustomer}
        />
      </div>
    </div>
  );
}
