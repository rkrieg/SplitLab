import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { rawQuery } from '@/lib/db';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import {
  FileCode2, Globe, CheckCircle2, Clock, PauseCircle, XCircle,
  FlaskConical as ABIcon, ExternalLink, Link2, ShieldCheck,
} from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';

interface Variant {
  id: string;
  name: string;
  traffic_weight: number;
  is_control: boolean;
  redirect_url: string | null;
}

interface RawTestRow {
  id: string;
  name: string;
  status: string;
  url_path: string;
  workspace_id: string;
  workspaces: { id: string; name: string; client_id: string; clients: { id: string; name: string } } | null;
}

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
  variants: Variant[];
}

async function getAllTests(userId: string): Promise<TestRow[]> {
  const wsRows = await rawQuery<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_members WHERE user_id = $1`,
    [userId]
  );
  const userWorkspaceIds = wsRows.map(r => r.workspace_id);
  if (userWorkspaceIds.length === 0) return [];

  const { data: tests } = await db
    .from('tests')
    .select('id, name, url_path, status, created_at, workspace_id, workspaces(id, name, client_id, clients(id, name))')
    .in('workspace_id', userWorkspaceIds)
    .order('created_at', { ascending: false }) as unknown as { data: RawTestRow[] | null };

  if (!tests || tests.length === 0) return [];

  const workspaceIds = Array.from(new Set(tests.map((t: RawTestRow) => t.workspace_id)));
  const testIds = tests.map((t: RawTestRow) => t.id);

  const [{ data: domains }, { data: events }, { data: variants }] = await Promise.all([
    db.from('domains').select('workspace_id, domain').in('workspace_id', workspaceIds),
    db.from('events').select('test_id, type').in('test_id', testIds),
    db.from('test_variants').select('test_id, id, name, traffic_weight, is_control, redirect_url').in('test_id', testIds),
  ]) as unknown as [
    { data: { workspace_id: string; domain: string }[] | null },
    { data: { test_id: string; type: string }[] | null },
    { data: { test_id: string; id: string; name: string; traffic_weight: number; is_control: boolean; redirect_url: string | null }[] | null },
  ];

  const domainMap: Record<string, string> = {};
  for (const d of domains || []) domainMap[d.workspace_id] = d.domain;

  const statsMap: Record<string, { views: number; conversions: number }> = {};
  for (const ev of events || []) {
    if (!statsMap[ev.test_id]) statsMap[ev.test_id] = { views: 0, conversions: 0 };
    if (ev.type === 'pageview') statsMap[ev.test_id].views++;
    else if (ev.type === 'conversion') statsMap[ev.test_id].conversions++;
  }

  const variantMap: Record<string, Variant[]> = {};
  for (const v of variants || []) {
    if (!variantMap[v.test_id]) variantMap[v.test_id] = [];
    variantMap[v.test_id].push({ id: v.id, name: v.name, traffic_weight: v.traffic_weight, is_control: v.is_control, redirect_url: v.redirect_url });
  }

  return tests.map((t: RawTestRow) => {
    const ws = t.workspaces;
    const s = statsMap[t.id] || { views: 0, conversions: 0 };
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      url_path: t.url_path,
      client_id: ws?.clients?.id ?? ws?.client_id ?? '',
      client_name: ws?.clients?.name ?? '',
      domain: domainMap[ws?.id ?? ''] ?? null,
      views: s.views,
      conversions: s.conversions,
      cvr: s.views > 0 ? (s.conversions / s.views) * 100 : 0,
      variants: variantMap[t.id] || [],
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

  const tests = await getAllTests(session.user.id);

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
          <div className="space-y-3">
            {tests.map((test) => {
              const fullUrl = test.domain ? `${test.domain}${test.url_path}` : test.url_path;
              const href = test.client_id ? `/clients/${test.client_id}/tests/${test.id}` : '#';

              return (
                <div key={test.id} className="card p-5 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                  <div className="flex items-start justify-between gap-4">

                    {/* Left: name + badges + url + variants */}
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <Link
                          href={href}
                          className="font-semibold text-slate-900 dark:text-slate-100 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                        >
                          {test.name}
                        </Link>
                        <StatusBadge status={test.status} />
                        {test.variants.length > 1 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#3D8BDA]/10 text-[#3D8BDA] border border-[#3D8BDA]/20">
                            <ABIcon size={8} />{test.variants.length} variants
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 mb-3">
                        <Globe size={10} className="text-slate-400 flex-shrink-0" />
                        <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">{fullUrl}</span>
                        {test.client_name && (
                          <>
                            <span className="text-slate-300 dark:text-slate-700 select-none">·</span>
                            <span className="text-xs text-slate-400 dark:text-slate-500">{test.client_name}</span>
                          </>
                        )}
                      </div>

                      {/* Variant chips */}
                      {test.variants.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {test.variants.map((v) => (
                            <span key={v.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-600">
                              {v.name}
                              <span className="text-slate-400">{v.traffic_weight}%</span>
                              {v.is_control && <span className="text-indigo-400 text-[9px] font-semibold">ctrl</span>}
                              {v.redirect_url && <Link2 size={9} className="text-amber-400" />}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Right: stats + action */}
                    <div className="flex items-center gap-5 flex-shrink-0">
                      <div className="text-right">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{test.views.toLocaleString()}</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">Visitors</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{test.conversions.toLocaleString()}</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">Conversions</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{test.cvr.toFixed(2)}%</p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500">Conv. Rate</p>
                      </div>
                      <div className="text-right">
                        <ConfidenceBadge views={test.views} cvr={test.cvr} />
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">Confidence</p>
                      </div>
                      <Link
                        href={href}
                        className="btn-secondary text-xs whitespace-nowrap"
                      >
                        Analytics
                      </Link>
                      <Link
                        href={href}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                        title="Open analytics"
                      >
                        <ExternalLink size={14} />
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
