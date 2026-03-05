import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { Building2, FlaskConical, FileCode2, Eye, TrendingUp } from 'lucide-react';

async function getDashboardStats() {
  const [
    { count: clientCount },
    { count: activeTestCount },
    { count: totalViews },
    { data: recentTests },
  ] = await Promise.all([
    db.from('clients').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    db.from('tests').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    db.from('events').select('*', { count: 'exact', head: true }).eq('type', 'pageview'),
    db
      .from('tests')
      .select('id, name, status, url_path, created_at, workspaces(name, clients(name))')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  return {
    clientCount: clientCount ?? 0,
    activeTestCount: activeTestCount ?? 0,
    totalViews: totalViews ?? 0,
    recentTests: recentTests ?? [],
  };
}

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const { clientCount, activeTestCount, totalViews, recentTests } =
    await getDashboardStats();

  const stats = [
    {
      label: 'Active Clients',
      value: clientCount,
      icon: Building2,
      color: 'text-indigo-400',
      bg: 'bg-indigo-500/10',
      href: '/pages',
    },
    {
      label: 'Active Pages',
      value: activeTestCount,
      icon: FileCode2,
      color: 'text-green-400',
      bg: 'bg-green-500/10',
      href: '/pages',
    },
    {
      label: 'Total Page Views',
      value: totalViews.toLocaleString(),
      icon: Eye,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
      href: null,
    },
    {
      label: 'Conversion Tracking',
      value: 'Live',
      icon: TrendingUp,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
      href: null,
    },
  ];

  return (
    <div>
      <Header
        title="Dashboard"
        subtitle={`Welcome back, ${session?.user?.name}`}
      />

      <div className="p-6 space-y-8">
        {/* Stats grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((stat) => (
            <div key={stat.label} className="card p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-slate-400 text-sm">{stat.label}</p>
                  <p className="text-2xl font-bold text-slate-100 mt-1">
                    {stat.value}
                  </p>
                </div>
                <div className={`w-10 h-10 rounded-xl ${stat.bg} flex items-center justify-center`}>
                  <stat.icon size={18} className={stat.color} />
                </div>
              </div>
              {stat.href && (
                <Link
                  href={stat.href}
                  className="text-xs text-indigo-400 hover:text-indigo-300 mt-3 inline-block"
                >
                  View all →
                </Link>
              )}
            </div>
          ))}
        </div>

        {/* Recent active tests */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Active Pages</h2>
            <Link href="/pages" className="text-sm text-indigo-400 hover:text-indigo-300">
              View all
            </Link>
          </div>

          {recentTests.length === 0 ? (
            <div className="card p-10 text-center">
              <FlaskConical className="mx-auto text-slate-600 mb-3" size={32} />
              <p className="text-slate-400 text-sm">No active tests yet.</p>
              <Link href="/clients" className="btn-primary mt-4 inline-flex">
                Create your first test
              </Link>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700">
                    <th className="text-left px-5 py-3 text-slate-400 font-medium">Test</th>
                    <th className="text-left px-5 py-3 text-slate-400 font-medium">Client</th>
                    <th className="text-left px-5 py-3 text-slate-400 font-medium">URL</th>
                    <th className="text-left px-5 py-3 text-slate-400 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTests.map((test: Record<string, unknown>) => {
                    const ws = test.workspaces as { name: string; clients: { name: string } } | null;
                    return (
                      <tr key={test.id as string} className="border-b border-slate-700/50 hover:bg-slate-700/30 transition-colors">
                        <td className="px-5 py-3 text-slate-200 font-medium">{test.name as string}</td>
                        <td className="px-5 py-3 text-slate-400">{ws?.clients?.name ?? '—'}</td>
                        <td className="px-5 py-3 text-slate-400 font-mono text-xs">{test.url_path as string}</td>
                        <td className="px-5 py-3">
                          <span className="badge bg-green-500/20 text-green-400 border border-green-500/30">
                            {test.status as string}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
