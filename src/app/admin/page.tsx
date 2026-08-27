import Link from 'next/link';
import { requireAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/supabase-server';
import { PLAN_DETAILS, TOKENS_PER_CREDIT, type PlanId } from '@/lib/plans';
import AdminGrowthCharts, { type GrowthPoint } from './AdminGrowthCharts';
import AdminRevenueChart from './AdminRevenueChart';
import { getRevenueByCustomer, getRevenueOverview, fmtMoney } from '@/lib/admin-revenue';

export const dynamic = 'force-dynamic';

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{sub}</p>}
    </div>
  );
}

export default async function AdminDashboard() {
  await requireAdmin();

  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const [{ data: users }, { data: clients }, { count: testCount }, { data: usage }] = await Promise.all([
    db.from('users').select('id, plan, status, subscription_status, created_at'),
    db.from('clients').select('owner_id'),
    db.from('tests').select('*', { count: 'exact', head: true }),
    db.from('ai_usage').select('input_tokens, output_tokens').gte('created_at', monthStart),
  ]);

  const u = users ?? [];
  const total = u.length;

  // An ACCOUNT = a user who owns a client (signup creates one). Members who
  // joined via invite own none — we track account signups, not those.
  const owners = new Set((clients ?? []).map((c) => c.owner_id).filter(Boolean));
  const isAccount = (x: { id: string }) => owners.has(x.id);
  const newAccounts7 = u.filter((x) => isAccount(x) && x.created_at >= iso(days(7))).length;
  const newAccounts30 = u.filter((x) => isAccount(x) && x.created_at >= iso(days(30))).length;

  const byPlan: Record<string, number> = {};
  for (const x of u) byPlan[x.plan ?? 'free'] = (byPlan[x.plan ?? 'free'] ?? 0) + 1;

  const paid = u.filter((x) => (x.plan ?? 'free') !== 'free').length;
  const activeSubs = u.filter((x) => x.subscription_status === 'active');
  const mrr = activeSubs.reduce((sum, x) => sum + (PLAN_DETAILS[(x.plan as PlanId)]?.monthlyPrice ?? 0), 0);

  const engaged = owners.size;

  const clientCount = (clients ?? []).length;
  const tokensThisMonth = (usage ?? []).reduce((a, r) => a + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
  const creditsThisMonth = Math.ceil(tokensThisMonth / TOKENS_PER_CREDIT);

  // Actual billed revenue (Stripe) — the real signal vs. DB plan flags.
  const [revenue, revOverview] = await Promise.all([getRevenueByCustomer(), getRevenueOverview(12)]);
  const revenueSeries = revOverview.series.map((p) => ({
    label: p.label,
    collected: Math.round(p.collectedCents) / 100,
    mrr: Math.round(p.mrrCents) / 100,
  }));

  // 90-day signup series: new per day + running total.
  const WIN = 90;
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (WIN - 1) * 86_400_000);
  const buckets = new Map<string, number>();
  let beforeCount = 0;
  for (const x of u) {
    if (!isAccount(x)) continue; // count new ACCOUNTS/day, not invited members
    const d = new Date(x.created_at);
    if (d < windowStart) { beforeCount++; continue; }
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const series: GrowthPoint[] = [];
  let cum = beforeCount;
  for (let i = 0; i < WIN; i++) {
    const d = new Date(windowStart.getTime() + i * 86_400_000);
    const n = buckets.get(d.toISOString().slice(0, 10)) ?? 0;
    cum += n;
    series.push({ label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), newUsers: n, cumulative: cum });
  }

  const { data: recent } = await db
    .from('users')
    .select('id, email, name, plan, subscription_status, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  const planOrder = ['free', 'pro', 'growth', 'agency', 'scale'];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Users, engagement, and revenue at a glance.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total users" value={total.toLocaleString()} sub={`${engaged.toLocaleString()} accounts`} />
        <StatCard label="New accounts (7 days)" value={newAccounts7.toLocaleString()} sub={`${newAccounts30.toLocaleString()} in last 30`} />
        <StatCard label="Accounts" value={engaged.toLocaleString()} sub="signed up (own a client)" />
        <StatCard label="Paid (by plan flag)" value={paid.toLocaleString()} sub={`${activeSubs.length} active subs`} />
        <StatCard label="MRR (active)" value={revOverview.available ? fmtMoney(revOverview.currentMrrCents) : `~$${mrr.toLocaleString()}`} sub={revOverview.available ? 'from Stripe' : 'estimated (no Stripe here)'} />
        <StatCard label="Total billed" value={revenue.available ? fmtMoney(revenue.totalCents) : '—'} sub={revenue.available ? 'all-time (Stripe)' : 'Stripe not configured'} />
        <StatCard label="Paying customers" value={revenue.available ? revenue.payingCustomers.toLocaleString() : '—'} sub="actually charged" />
        <StatCard label="Clients" value={clientCount.toLocaleString()} />
        <StatCard label="Tests" value={(testCount ?? 0).toLocaleString()} />
        <StatCard label="AI credits used" value={creditsThisMonth.toLocaleString()} sub="this month" />
      </div>

      {/* Growth chart */}
      <AdminGrowthCharts data={series} />

      {/* Revenue + MRR chart */}
      <AdminRevenueChart data={revenueSeries} available={revOverview.available} />

      {/* By plan */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
        <h2 className="text-sm font-semibold mb-3">Users by plan</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {planOrder.map((p) => (
            <div key={p} className="text-center rounded-lg bg-slate-50 dark:bg-slate-800/50 py-3">
              <p className="text-lg font-semibold tabular-nums">{(byPlan[p] ?? 0).toLocaleString()}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 capitalize">{p}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Recent signups */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent signups</h2>
          <Link href="/admin/users" className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">View all users</Link>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800">
              <th className="px-5 py-2 font-medium">User</th>
              <th className="px-5 py-2 font-medium">Plan</th>
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-5 py-2 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {(recent ?? []).map((r) => (
              <tr key={r.id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="px-5 py-2.5">
                  <Link href={`/admin/users/${r.id}`} className="hover:text-indigo-600 dark:hover:text-indigo-400">
                    <span className="font-medium">{r.name || '—'}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{r.email}</span>
                  </Link>
                </td>
                <td className="px-5 py-2.5 capitalize">{r.plan ?? 'free'}</td>
                <td className="px-5 py-2.5 text-slate-500 dark:text-slate-400">{r.subscription_status ?? '—'}</td>
                <td className="px-5 py-2.5 text-slate-500 dark:text-slate-400">{new Date(r.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
