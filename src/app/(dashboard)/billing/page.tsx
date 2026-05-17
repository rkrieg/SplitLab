  import { getServerSession } from 'next-auth';
  import { redirect } from 'next/navigation';
  import { authOptions } from '@/lib/auth';
  import { rawQuery } from '@/lib/db';
  import Header from '@/components/layout/Header';
  import BillingClient from './BillingClient';

  export default async function BillingPage() {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) redirect('/login');

    let plan = 'starter';
    let status = 'active';
    let hasStripeCustomer = false;

    try {
      const rows = await rawQuery<{
        plan: string;
        stripe_customer_id: string | null;
        subscription_status: string;
      }>(
        'SELECT plan, stripe_customer_id, subscription_status FROM users WHERE id = $1',
        [session.user.id]
      );

      const user = rows[0];
      plan = user?.plan ?? 'starter';
      status = user?.subscription_status ?? 'active';
      hasStripeCustomer = !!user?.stripe_customer_id;
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
          />
        </div>
      </div>
    );
  }