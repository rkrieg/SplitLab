import Link from 'next/link';
import { requireAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/supabase-server';
import { getRevenueByCustomer, fmtMoney } from '@/lib/admin-revenue';
import { classifyAccount, ACCOUNT_TYPE_META } from '@/lib/admin-classify';
import { Search } from 'lucide-react';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function AdminUsers({
  searchParams,
}: {
  searchParams: { q?: string; page?: string };
}) {
  await requireAdmin();

  const q = (searchParams.q ?? '').trim();
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = db
    .from('users')
    .select('id, email, name, role, plan, status, subscription_status, created_at, stripe_customer_id, stripe_subscription_id', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (q) query = query.or(`email.ilike.%${q}%,name.ilike.%${q}%`);

  const { data: users, count } = await query.range(from, to);

  // Per-user client counts (one query, mapped in memory).
  const { data: clients } = await db.from('clients').select('owner_id');
  const clientCounts = new Map<string, number>();
  for (const c of clients ?? []) {
    if (c.owner_id) clientCounts.set(c.owner_id, (clientCounts.get(c.owner_id) ?? 0) + 1);
  }

  // Actual billed revenue per Stripe customer (real payers stand out from test accounts).
  const revenue = await getRevenueByCustomer();

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const mkHref = (p: number) => `/admin/users?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Users</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{(count ?? 0).toLocaleString()} total</p>
        </div>
        <form className="relative" action="/admin/users" method="GET">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Search email or name…"
            className="w-64 pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </form>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800">
              <th className="px-5 py-2.5 font-medium">User</th>
              <th className="px-5 py-2.5 font-medium">Role</th>
              <th className="px-5 py-2.5 font-medium">Type</th>
              <th className="px-5 py-2.5 font-medium">Plan</th>
              <th className="px-5 py-2.5 font-medium">Subscription</th>
              <th className="px-5 py-2.5 font-medium text-right">Clients</th>
              <th className="px-5 py-2.5 font-medium text-right">Billed</th>
              <th className="px-5 py-2.5 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => {
              const billed = u.stripe_customer_id ? (revenue.byCustomer.get(u.stripe_customer_id) ?? 0) : 0;
              const type = classifyAccount(u, revenue.available ? billed : 0);
              const meta = ACCOUNT_TYPE_META[type];
              return (
              <tr key={u.id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="px-5 py-3">
                  <Link href={`/admin/users/${u.id}`} className="hover:text-indigo-600 dark:hover:text-indigo-400">
                    <span className="font-medium">{u.name || '—'}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{u.email}</span>
                  </Link>
                </td>
                <td className="px-5 py-3 capitalize text-slate-600 dark:text-slate-300">{u.role}</td>
                <td className="px-5 py-3">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${meta.badge}`}>{meta.label}</span>
                </td>
                <td className="px-5 py-3 capitalize">{u.plan ?? 'free'}</td>
                <td className="px-5 py-3 text-slate-500 dark:text-slate-400">{u.subscription_status ?? '—'}</td>
                <td className="px-5 py-3 text-right tabular-nums">{clientCounts.get(u.id) ?? 0}</td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {!revenue.available ? '—'
                    : (billed > 0
                        ? <span className="font-semibold text-green-700 dark:text-green-400">{fmtMoney(billed)}</span>
                        : <span className="text-slate-400">$0.00</span>)}
                </td>
                <td className="px-5 py-3 text-slate-500 dark:text-slate-400">{new Date(u.created_at).toLocaleDateString()}</td>
              </tr>
              );
            })}
            {(users ?? []).length === 0 && (
              <tr><td colSpan={8} className="px-5 py-10 text-center text-slate-400">No users found{q ? ` for “${q}”` : ''}.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500 dark:text-slate-400">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            {page > 1 && <Link href={mkHref(page - 1)} className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">Previous</Link>}
            {page < totalPages && <Link href={mkHref(page + 1)} className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">Next</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
