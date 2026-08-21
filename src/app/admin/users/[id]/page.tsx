import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/supabase-server';
import { getAiUsageSummary } from '@/lib/ai-usage';
import { getPlanDetails } from '@/lib/plans';
import { ArrowLeft } from 'lucide-react';
import UserActions from './UserActions';

export const dynamic = 'force-dynamic';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-slate-50 dark:border-slate-800/50 last:border-0">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="text-slate-800 dark:text-slate-200 text-right break-all">{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export default async function AdminUserDetail({ params }: { params: { id: string } }) {
  await requireAdmin();

  const { data: user } = await db
    .from('users')
    .select('id, email, name, role, status, plan, created_at, updated_at, stripe_customer_id, subscription_status, subscription_current_period_end, ai_overage_enabled, ai_overage_cap_cents')
    .eq('id', params.id)
    .maybeSingle();

  if (!user) notFound();

  const plan = user.plan ?? 'free';
  const [{ data: clients }, usage] = await Promise.all([
    db.from('clients').select('id, name, created_at').eq('owner_id', user.id).order('created_at', { ascending: false }),
    getAiUsageSummary(user.id, plan),
  ]);

  const clientIds = (clients ?? []).map((c) => c.id);
  const testsByClient = new Map<string, number>();
  if (clientIds.length) {
    const { data: workspaces } = await db.from('workspaces').select('id, client_id').in('client_id', clientIds);
    const wsToClient = new Map((workspaces ?? []).map((w) => [w.id, w.client_id]));
    const wsIds = (workspaces ?? []).map((w) => w.id);
    if (wsIds.length) {
      const { data: tests } = await db.from('tests').select('workspace_id').in('workspace_id', wsIds);
      for (const t of tests ?? []) {
        const cid = wsToClient.get(t.workspace_id);
        if (cid) testsByClient.set(cid, (testsByClient.get(cid) ?? 0) + 1);
      }
    }
  }

  const planDetails = getPlanDetails(plan);

  return (
    <div className="space-y-6 max-w-4xl">
      <Link href="/admin/users" className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400">
        <ArrowLeft size={15} /> All users
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{user.name || '—'}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{user.email}</p>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 capitalize">{user.role}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 capitalize">{plan}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{user.status}</span>
          </div>
        </div>
        <UserActions userId={user.id} userEmail={user.email} currentPlan={plan} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card title="Profile">
          <Row label="User ID" value={<code className="text-xs">{user.id}</code>} />
          <Row label="Role" value={<span className="capitalize">{user.role}</span>} />
          <Row label="Status" value={user.status} />
          <Row label="Joined" value={new Date(user.created_at).toLocaleString()} />
          <Row label="Last updated" value={user.updated_at ? new Date(user.updated_at).toLocaleString() : '—'} />
        </Card>

        <Card title="Billing & plan">
          <Row label="Plan" value={<span className="capitalize">{plan}</span>} />
          <Row label="Price" value={planDetails.monthlyPrice != null ? `$${planDetails.monthlyPrice}/mo` : 'Free'} />
          <Row label="Subscription" value={user.subscription_status ?? '—'} />
          <Row label="Renews / ends" value={user.subscription_current_period_end ? new Date(user.subscription_current_period_end).toLocaleDateString() : '—'} />
          <Row label="Stripe customer" value={user.stripe_customer_id
            ? <a className="text-indigo-600 dark:text-indigo-400 hover:underline" href={`https://dashboard.stripe.com/customers/${user.stripe_customer_id}`} target="_blank" rel="noreferrer">{user.stripe_customer_id}</a>
            : '—'} />
          <Row label="Overage" value={user.ai_overage_enabled ? `On (cap $${((user.ai_overage_cap_cents ?? 0) / 100).toFixed(0)})` : 'Off'} />
        </Card>

        <Card title="AI usage (this month)">
          <Row label="Credits used" value={`${usage.creditsUsed.toLocaleString()} / ${usage.creditsIncluded.toLocaleString()}`} />
          <Row label="Plan credits" value={(usage.planCredits ?? 0).toLocaleString()} />
          <Row label="Purchased (top-ups)" value={(usage.topupCredits ?? 0).toLocaleString()} />
          <Row label="Overage cost" value={`$${(usage.overageCostCents / 100).toFixed(2)}`} />
        </Card>

        <Card title={`Clients (${(clients ?? []).length})`}>
          {(clients ?? []).length === 0 ? (
            <p className="text-slate-400 py-2">No clients yet.</p>
          ) : (
            <div className="divide-y divide-slate-50 dark:divide-slate-800/50">
              {(clients ?? []).map((c) => (
                <div key={c.id} className="flex justify-between py-2">
                  <Link href={`/clients/${c.id}`} className="hover:text-indigo-600 dark:hover:text-indigo-400">{c.name}</Link>
                  <span className="text-slate-500 dark:text-slate-400">{testsByClient.get(c.id) ?? 0} tests</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
