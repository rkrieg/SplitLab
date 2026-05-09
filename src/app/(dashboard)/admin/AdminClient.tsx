'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Eye, Search, Users, Activity, Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AccountUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  plan: string;
  created_at: string;
  visitor_count: number;
  test_count: number;
  client_count: number;
}

const PLAN_COLORS: Record<string, string> = {
  starter: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  pro: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  agency: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  scale: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
};

export default function AdminClient({
  users,
  currentUserId,
}: {
  users: AccountUser[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [impersonating, setImpersonating] = useState<string | null>(null);

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
  );

  async function handleImpersonate(userId: string) {
    setImpersonating(userId);
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to impersonate');
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch {
      alert('An error occurred');
    } finally {
      setImpersonating(null);
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl bg-indigo-600/10 flex items-center justify-center">
            <Shield size={18} className="text-indigo-500" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Super Admin</h1>
        </div>
        <p className="text-slate-500 dark:text-slate-400 text-sm">
          View and access any account on the platform. Use impersonation responsibly.
        </p>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mb-1">Total Accounts</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{users.length}</p>
        </div>
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mb-1">Active Accounts</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            {users.filter((u) => u.status === 'active').length}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mb-1">Total Visitors This Month</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            {users.reduce((sum, u) => sum + u.visitor_count, 0).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-700">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-700">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Account</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Plan</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Status</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  <div className="flex items-center justify-end gap-1"><Building2 size={11} /> Clients</div>
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  <div className="flex items-center justify-end gap-1"><Activity size={11} /> Tests</div>
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  <div className="flex items-center justify-end gap-1"><Users size={11} /> Visitors</div>
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Joined</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-slate-400 dark:text-slate-500">
                    No accounts found
                  </td>
                </tr>
              )}
              {filtered.map((user) => (
                <tr
                  key={user.id}
                  className={cn(
                    'hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors',
                    user.id === currentUserId && 'bg-indigo-50/50 dark:bg-indigo-900/10'
                  )}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                        {user.name[0]?.toUpperCase() || '?'}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {user.name}
                          {user.id === currentUserId && (
                            <span className="ml-2 text-xs text-indigo-400 font-normal">(you)</span>
                          )}
                        </p>
                        <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs font-semibold px-2 py-1 rounded-full capitalize', PLAN_COLORS[user.plan] || PLAN_COLORS.starter)}>
                      {user.plan}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'text-xs font-semibold px-2 py-1 rounded-full capitalize',
                      user.status === 'active'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400'
                    )}>
                      {user.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-700 dark:text-slate-300">
                    {user.client_count}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-700 dark:text-slate-300">
                    {user.test_count}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-700 dark:text-slate-300">
                    {user.visitor_count.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 dark:text-slate-500">
                    {new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {user.id !== currentUserId ? (
                      <button
                        onClick={() => handleImpersonate(user.id)}
                        disabled={impersonating === user.id}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-60"
                      >
                        <Eye size={12} />
                        {impersonating === user.id ? 'Entering…' : 'View Account'}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
