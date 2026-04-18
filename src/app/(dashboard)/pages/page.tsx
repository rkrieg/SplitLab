import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import {
  FileCode2, Globe, CheckCircle2, Clock, PauseCircle, XCircle,
  FlaskConical as ABIcon, ExternalLink,
} from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';

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

async function getAllTests(): Promise<TestRow[]> {
  const { data: tests } = await db
    .from('tests')
    .select('id, name, url_path, status, created_at, workspace_id, workspaces(id, name, client_id, clients(id, name))')
    .order('created_at', { ascending: false });

  if (!tests || tests.length === 0) return [];

  const workspaceIds = [...new Set(tests.map((t: Record<string, unknown>) => t.workspace_id as string))];

  const { data: domains } = await db
    .from('domains')
    .select('workspace_id, domain')
    .in('workspace_id', workspaceIds);

  const domainMap: Record<string, string> = {};
  for (const d of domains || []) domainMap[d.workspace_id] = d.domain;

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
    const ws = t.workspaces as { id: string; name: string; client_id: string; clients: { id: string; name: string } } | null;
    const s = statsMap[t.id as string] || { views: 0, conversions: 0 };
    return {
      id: t.id as string,
      name: t.name as string,
      status: t.status as string,
      url_path: t.url_path as string,
      client_id: ws?.clients?.id ?? ws?.client_id ?? '',
      client_name: ws?.clients?.name ?? '',
      domain: domainMap[ws?.id ?? ''] ?? null,
      views: s.views,
      conversions: s.conversions,
      cvr: s.views > 0 ? (s.conversions / s.views) * 100 : 0,
      variant_count: variantCountMap[t.id as string] || 0,
    };
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

export default async function AllPagesPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const tests = await getAllTests();

  return (
    <div>
      <Header
        title="All Pages"
        subtitle={`${tests.length} page${tests.length !== 1 ? 's' : ''} across all client workspaces`}
      />

      <div className="p-6">
        {tests.length === 0 ? (
          <EmptyState
            icon={FileCode2}
            title="No pages yet"
            description="Pages will appear here once created in a client workspace."
          />
        ) : (
          <div className="card overflow-hidden">
            {/* Column header row */}
            <div className="hidden sm:flex items-center px-5 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40">
              <div className="flex-1 text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Page</div>
              <div className="flex items-center gap-6 pr-1">
                {['Visitors', 'Conversions', 'Conv. Rate', 'Confidence'].map(col => (
                  <div key={col} className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide text-right min-w-[80px]">
                    {col}
                  </div>
                ))}
                <div className="w-7" />
              </div>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
              {tests.map((test) => {
                const fullUrl = test.domain
                  ? `${test.domain}${test.url_path}`
                  : test.url_path;
                const href = test.client_id ? `/clients/${test.client_id}/tests/${test.id}` : '#';

                return (
                  <div key={test.id} className="flex items-center px-5 py-3.5 hover:bg-slate-50 dark:hover:bg-slate-700/20 transition-colors group">

                    {/* Left: name + badges + url */}
                    <div className="flex-1 min-w-0 pr-6">
                      <div className="flex flex-wrap items-center gap-2 mb-0.5">
                        <Link
                          href={href}
                          className="font-semibold text-sm text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors truncate max-w-[400px]"
                        >
                          {test.name}
                        </Link>
                        <StatusBadge status={test.status} />
                        {test.variant_count > 1 && (
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
                        {test.client_name && (
                          <>
                            <span className="text-slate-300 dark:text-slate-700 text-xs select-none">·</span>
                            <span className="text-xs text-slate-400 dark:text-slate-500 truncate">{test.client_name}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Right: stats */}
                    <div className="flex items-center gap-6 flex-shrink-0 pr-1">
                      <div className="text-right min-w-[80px]">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{test.views.toLocaleString()}</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">Visitors</p>
                      </div>
                      <div className="text-right min-w-[80px]">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{test.conversions.toLocaleString()}</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">Conversions</p>
                      </div>
                      <div className="text-right min-w-[80px]">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{test.cvr.toFixed(2)}%</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">Conv. Rate</p>
                      </div>
                      <div className="text-right min-w-[80px]">
                        <ConfidenceBadge views={test.views} cvr={test.cvr} />
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">Confidence</p>
                      </div>

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
