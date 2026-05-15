import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { rawQuery } from '@/lib/db';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import {
  FlaskConical, Globe, CheckCircle2, Clock, PauseCircle,
  XCircle, Eye, TrendingUp, FlaskConical as ABIcon,
  MoreHorizontal, ExternalLink,
} from 'lucide-react';
import UsageBanner from '@/components/usage/UsageBanner';

interface TestRow {
  id: string;
  name: string;
  status: string;
  url_path: string;
  client_id: string;
  client_name: string;
  domain: string | null;
  views: number;
  conversions: number;
  cvr: number;
  variant_count: number;
}

type RawTest = Record<string, unknown>;

async function getAllPages(userId: string) {
  const wsRows = await rawQuery<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_members WHERE user_id = $1`,
    [userId]
  );
  const userWorkspaceIds = wsRows.map(r => r.workspace_id);
  if (userWorkspaceIds.length === 0) return [];

  const { data: tests } = await db
    .from('tests')
    .select('id, name, status, url_path, created_at, workspace_id, workspaces(id, name, clients(id, name))')
    .in('workspace_id', userWorkspaceIds)
    .order('created_at', { ascending: false }) as unknown as { data: RawTest[] | null };

  if (!tests || tests.length === 0) return [];

  const workspaceIds = Array.from(new Set(tests.map((t: Record<string, unknown>) => t.workspace_id as string)));

  const { data: domains } = await db
    .from('domains')
    .select('workspace_id, domain')
    .in('workspace_id', workspaceIds) as unknown as { data: { workspace_id: string; domain: string }[] | null };

  const domainMap: Record<string, string> = {};
  for (const d of domains || []) domainMap[d.workspace_id] = d.domain;

  const testIds = tests.map((t: Record<string, unknown>) => t.id as string);

  const { data: events } = await db
    .from('events')
    .select('test_id, type')
    .in('test_id', testIds) as unknown as { data: { test_id: string; type: string }[] | null };

  const statsMap: Record<string, { views: number; conversions: number }> = {};
  for (const ev of events || []) {
    if (!statsMap[ev.test_id]) statsMap[ev.test_id] = { views: 0, conversions: 0 };
    if (ev.type === 'pageview') statsMap[ev.test_id].views++;
    else if (ev.type === 'conversion') statsMap[ev.test_id].conversions++;
  }

  const { data: variants } = await db
    .from('test_variants')
    .select('test_id')
    .in('test_id', testIds) as unknown as { data: { test_id: string }[] | null };

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
  if (status === 'active') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400 border border-green-200 dark:border-green-500/30">
      <CheckCircle2 size={9} />Published
    </span>
  );
  if (status === 'paused') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30">
      <PauseCircle size={9} />Paused
    </span>
  );
  if (status === 'completed') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400 border border-slate-200 dark:border-slate-600">
      <XCircle size={9} />Completed
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
      <Clock size={9} />Draft
    </span>
  );
}

function ConfidenceBadge({ views, cvr }: { views: number; cvr: number }) {
  if (views === 0) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-400 dark:bg-slate-700 dark:text-slate-500 border border-slate-200 dark:border-slate-600">
      Untested
    </span>
  );
  if (views >= 200 && cvr > 0) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400 border border-green-200 dark:border-green-500/30">
      High
    </span>
  );
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30">
      Medium
    </span>
  );
}

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const pages = await getAllPages(session?.user?.id ?? '');

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

      <div className="p-6 space-y-5">

        {/* Usage meters + warnings */}
        <UsageBanner />

        {/* Summary strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total Pages', value: pages.length, Icon: FlaskConical, color: 'text-indigo-500', bg: 'bg-indigo-50 dark:bg-indigo-500/10' },
            { label: 'Published', value: totalActive, Icon: CheckCircle2, color: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-500/10' },
            { label: 'Total Visitors', value: totalViews.toLocaleString(), Icon: Eye, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-500/10' },
            { label: 'Avg Conv. Rate', value: `${overallCvr.toFixed(1)}%`, Icon: TrendingUp, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-500/10' },
          ].map(({ label, value, Icon, color, bg }) => (
            <div key={label} className="card p-4 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg ${bg} flex items-center justify-center flex-shrink-0`}>
                <Icon size={16} className={color} />
              </div>
              <div>
                <p className="text-xl font-bold text-slate-900 dark:text-slate-100 leading-tight">{value}</p>
                <p className="text-slate-500 dark:text-slate-400 text-xs">{label}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Pages list */}
        {pages.length === 0 ? (
          <div className="card p-16 text-center">
            <FlaskConical className="mx-auto text-slate-300 dark:text-slate-600 mb-3" size={40} />
            <p className="text-slate-600 dark:text-slate-400 font-medium mb-1">No pages yet</p>
            <p className="text-slate-400 dark:text-slate-500 text-sm mb-5">Create your first A/B test to get started.</p>
            <Link href="/clients" className="btn-primary inline-flex">Go to Clients</Link>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
              {pages.map((page) => {
                const fullUrl = page.domain
                  ? `${page.domain}${page.url_path}`
                  : page.url_path;
                const href = `/clients/${page.client_id}/tests/${page.id}`;

                return (
                  <div key={page.id} className="flex items-center px-5 py-3.5 hover:bg-slate-50 dark:hover:bg-slate-700/20 transition-colors group">

                    {/* Left: name + badges + url */}
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="flex flex-wrap items-center gap-2 mb-0.5">
                        <Link href={href} className="font-semibold text-sm text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors truncate max-w-[400px]">
                          {page.name}
                        </Link>
                        <StatusBadge status={page.status} />
                        {page.variant_count > 1 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#3D8BDA]/10 text-[#3D8BDA] border border-[#3D8BDA]/20">
                            <ABIcon size={8} />A/B Test
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Globe size={10} className="text-slate-400 flex-shrink-0" />
                        <span className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">
                          {fullUrl}
                        </span>
                        {page.client_name && (
                          <>
                            <span className="text-slate-300 dark:text-slate-700 text-xs select-none">·</span>
                            <span className="text-xs text-slate-400 dark:text-slate-500 truncate">{page.client_name}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Right: stats */}
                    <div className="flex items-center gap-6 flex-shrink-0">
                      {/* Visitors */}
                      <div className="text-right min-w-[60px]">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{page.views.toLocaleString()}</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">Visitors</p>
                      </div>

                      {/* Conversions */}
                      <div className="text-right min-w-[80px]">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{page.conversions.toLocaleString()}</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">Conversions</p>
                      </div>

                      {/* CVR */}
                      <div className="text-right min-w-[80px]">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{page.cvr.toFixed(2)}%</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">Conversion Rate</p>
                      </div>

                      {/* Confidence */}
                      <div className="text-right min-w-[64px]">
                        <ConfidenceBadge views={page.views} cvr={page.cvr} />
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">Confidence</p>
                      </div>

                      {/* Open link */}
                      <Link
                        href={href}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                        title="View analytics"
                      >
                        <ExternalLink size={14} />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
