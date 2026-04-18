import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { FlaskConical, Globe, CheckCircle2, Clock, PauseCircle, XCircle, Eye, TrendingUp } from 'lucide-react';

interface TestRow {
  id: string;
  name: string;
  status: string;
  url_path: string;
  created_at: string;
  workspace_id: string;
  client_id: string;
  client_name: string;
  domain: string | null;
  views: number;
  conversions: number;
  cvr: number;
  variant_count: number;
}

async function getAllPages() {
  const { data: tests } = await db
    .from('tests')
    .select('id, name, status, url_path, created_at, workspace_id, workspaces(id, name, clients(id, name))')
    .order('created_at', { ascending: false });

  if (!tests || tests.length === 0) return [];

  const workspaceIds = [...new Set(tests.map((t: Record<string, unknown>) => t.workspace_id as string))];

  const { data: domains } = await db
    .from('domains')
    .select('workspace_id, domain')
    .in('workspace_id', workspaceIds);

  const domainMap: Record<string, string> = {};
  for (const d of domains || []) {
    domainMap[d.workspace_id] = d.domain;
  }

  const testIds = tests.map((t: Record<string, unknown>) => t.id as string);

  const { data: events } = await db
    .from('events')
    .select('test_id, type')
    .in('test_id', testIds);

  const statsMap: Record<string, { views: number; conversions: number }> = {};
  for (const ev of events || []) {
    if (!statsMap[ev.test_id]) statsMap[ev.test_id] = { views: 0, conversions: 0 };
    if (ev.type === 'pageview') statsMap[ev.test_id].views++;
    else if (ev.type === 'conversion') statsMap[ev.test_id].conversions++;
  }

  const { data: variants } = await db
    .from('test_variants')
    .select('test_id')
    .in('test_id', testIds);

  const variantCountMap: Record<string, number> = {};
  for (const v of variants || []) {
    variantCountMap[v.test_id] = (variantCountMap[v.test_id] || 0) + 1;
  }

  return tests.map((t: Record<string, unknown>) => {
    const ws = t.workspaces as { id: string; name: string; clients: { id: string; name: string } } | null;
    const s = statsMap[t.id as string] || { views: 0, conversions: 0 };
    return {
      id: t.id as string,
      name: t.name as string,
      status: t.status as string,
      url_path: t.url_path as string,
      created_at: t.created_at as string,
      workspace_id: ws?.id ?? '',
      client_id: ws?.clients?.id ?? '',
      client_name: ws?.clients?.name ?? '',
      domain: domainMap[ws?.id ?? ''] ?? null,
      views: s.views,
      conversions: s.conversions,
      cvr: s.views > 0 ? (s.conversions / s.views) * 100 : 0,
      variant_count: variantCountMap[t.id as string] || 0,
    } as TestRow;
  });
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400 border border-green-200 dark:border-green-500/30">
        <CheckCircle2 size={10} />
        Published
      </span>
    );
  }
  if (status === 'paused') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30">
        <PauseCircle size={10} />
        Paused
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400 border border-slate-200 dark:border-slate-600">
        <XCircle size={10} />
        Completed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500 dark:bg-slate-700/60 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
      <Clock size={10} />
      Draft
    </span>
  );
}

function StatCell({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="text-center min-w-[80px]">
      <p className="text-slate-900 dark:text-slate-100 font-semibold text-sm tabular-nums">{value}</p>
      <p className="text-slate-400 dark:text-slate-500 text-[10px] uppercase tracking-wide mt-0.5">{label}</p>
    </div>
  );
}

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const pages = await getAllPages();

  const totalActive = pages.filter(p => p.status === 'active').length;
  const totalViews = pages.reduce((s, p) => s + p.views, 0);
  const totalConversions = pages.reduce((s, p) => s + p.conversions, 0);
  const overallCvr = totalViews > 0 ? (totalConversions / totalViews) * 100 : 0;

  return (
    <div>
      <Header
        title="All Pages"
        subtitle={`Welcome back, ${session?.user?.name}`}
      />

      <div className="p-6 space-y-6">

        {/* Summary strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="card p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
              <FlaskConical size={16} className="text-indigo-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{pages.length}</p>
              <p className="text-slate-500 dark:text-slate-400 text-xs">Total Pages</p>
            </div>
          </div>
          <div className="card p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center flex-shrink-0">
              <CheckCircle2 size={16} className="text-green-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{totalActive}</p>
              <p className="text-slate-500 dark:text-slate-400 text-xs">Published</p>
            </div>
          </div>
          <div className="card p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0">
              <Eye size={16} className="text-blue-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{totalViews.toLocaleString()}</p>
              <p className="text-slate-500 dark:text-slate-400 text-xs">Total Views</p>
            </div>
          </div>
          <div className="card p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0">
              <TrendingUp size={16} className="text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{overallCvr.toFixed(1)}%</p>
              <p className="text-slate-500 dark:text-slate-400 text-xs">Avg CVR</p>
            </div>
          </div>
        </div>

        {/* All pages list */}
        {pages.length === 0 ? (
          <div className="card p-16 text-center">
            <FlaskConical className="mx-auto text-slate-300 dark:text-slate-600 mb-3" size={40} />
            <p className="text-slate-500 dark:text-slate-400 font-medium mb-1">No pages yet</p>
            <p className="text-slate-400 dark:text-slate-500 text-sm mb-5">Create your first A/B test to get started.</p>
            <Link href="/clients" className="btn-primary inline-flex">
              Go to Clients
            </Link>
          </div>
        ) : (
          <div className="card overflow-hidden">
            {/* Column header */}
            <div className="hidden sm:flex items-center px-5 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40">
              <div className="flex-1 text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Page</div>
              <div className="flex items-center gap-0">
                {['Visitors', 'Conversions', 'CVR', 'Variants'].map(col => (
                  <div key={col} className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide text-center min-w-[80px]">
                    {col}
                  </div>
                ))}
              </div>
            </div>

            <div className="divide-y divide-slate-200 dark:divide-slate-700/60">
              {pages.map((page) => {
                const fullUrl = page.domain
                  ? `${page.domain}${page.url_path}`
                  : page.url_path;
                const href = `/clients/${page.client_id}/tests/${page.id}`;

                return (
                  <Link
                    key={page.id}
                    href={href}
                    className="flex flex-col sm:flex-row items-start sm:items-center px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-700/20 transition-colors group"
                  >
                    {/* Left: name + url + client */}
                    <div className="flex-1 min-w-0 pr-4 mb-3 sm:mb-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="font-medium text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                          {page.name}
                        </span>
                        <StatusBadge status={page.status} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Globe size={11} className="text-slate-400 flex-shrink-0" />
                        <span className="text-xs font-mono text-slate-400 dark:text-slate-500 truncate">
                          {fullUrl}
                        </span>
                        {page.client_name && (
                          <>
                            <span className="text-slate-300 dark:text-slate-600 text-xs">·</span>
                            <span className="text-xs text-slate-400 dark:text-slate-500 truncate">{page.client_name}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Right: stats */}
                    <div className="flex items-center gap-0 flex-shrink-0">
                      <StatCell value={page.views.toLocaleString()} label="Visitors" />
                      <StatCell value={page.conversions.toLocaleString()} label="Conversions" />
                      <StatCell value={`${page.cvr.toFixed(1)}%`} label="CVR" />
                      <StatCell value={page.variant_count} label="Variants" />
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
