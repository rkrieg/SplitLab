'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Download, RefreshCw, Trophy, TrendingUp, Code2, Copy, ChevronDown, ChevronUp, ShieldCheck, ShieldX, Loader2 } from 'lucide-react';
import { TestStatusBadge } from '@/components/ui/Badge';
import { formatPercent } from '@/lib/utils';

interface Variant {
  id: string;
  name: string;
  is_control: boolean;
  traffic_weight: number;
  redirect_url?: string | null;
  pages?: { id: string; name: string } | null;
  tracking_verified?: boolean | null;
  tracking_verified_at?: string | null;
}

interface Goal {
  id: string;
  name: string;
  type: string;
  selector: string | null;
  url_pattern: string | null;
  is_primary: boolean;
}

interface VariantStat {
  variant: Variant;
  views: number;
  conversions: number;
  cvr: number;
  confidence: number | null;
  isWinner: boolean;
}

interface Test {
  id: string;
  name: string;
  url_path: string;
  status: string;
  test_variants?: Variant[];
  conversion_goals?: Goal[];
}

interface Props {
  test: Test;
  appUrl: string;
}

export default function AnalyticsClient({ test, appUrl }: Props) {
  const [stats, setStats] = useState<VariantStat[]>([]);
  const [totalViews, setTotalViews] = useState(0);
  const [totalConversions, setTotalConversions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [checkingTracking, setCheckingTracking] = useState<string | null>(null);
  const [variantOverrides, setVariantOverrides] = useState<Record<string, { tracking_verified: boolean; tracking_verified_at: string }>>({});

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);

      const res = await fetch(`/api/tests/${test.id}/analytics?${params}`);
      if (!res.ok) throw new Error('Failed to fetch analytics');
      const data = await res.json();
      setStats(data.variantStats ?? []);
      setTotalViews(data.totalViews ?? 0);
      setTotalConversions(data.totalConversions ?? 0);
    } catch {
      toast.error('Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [test.id, from, to]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  function exportCsv() {
    const headers = ['Variant', 'Control', 'Views', 'Conversions', 'CVR', 'Confidence', 'Winner'];
    const rows = stats.map((s) => [
      s.variant.name,
      s.variant.is_control ? 'Yes' : 'No',
      s.views,
      s.conversions,
      formatPercent(s.cvr * 100),
      s.confidence !== null ? formatPercent(s.confidence) : 'N/A',
      s.isWinner ? 'Yes' : 'No',
    ]);
    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${test.name.replace(/\s+/g, '_')}_analytics.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const winner = stats.find((s) => s.isWinner);
  const overallCvr = totalViews > 0 ? totalConversions / totalViews : 0;

  const variants = test.test_variants || [];
  const goals = test.conversion_goals || [];

  const snippet = `<script src="${appUrl}/tracker.js"></script>`;

  function copySnippet() {
    navigator.clipboard.writeText(snippet);
    toast.success('Snippet copied to clipboard');
  }

  async function checkTracking(variantId: string, url: string) {
    setCheckingTracking(variantId);
    try {
      const res = await fetch('/api/check-tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, variant_id: variantId }),
      });
      const data = await res.json();
      setVariantOverrides((prev) => ({
        ...prev,
        [variantId]: { tracking_verified: data.verified, tracking_verified_at: data.checked_at },
      }));
      if (data.verified) {
        toast.success('Tracker verified on target page');
      } else {
        toast.error('Tracker not found on target page');
      }
    } catch {
      toast.error('Failed to check tracking');
    } finally {
      setCheckingTracking(null);
    }
  }

  function getVerifiedStatus(v: Variant) {
    if (variantOverrides[v.id]) return variantOverrides[v.id].tracking_verified;
    return v.tracking_verified;
  }

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-4">
        <TestStatusBadge status={test.status} />
        <div className="flex items-center gap-6 text-sm ml-2">
          <div>
            <span className="text-slate-400">Total Views </span>
            <span className="text-slate-100 font-semibold">{totalViews.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-slate-400">Total Conversions </span>
            <span className="text-slate-100 font-semibold">{totalConversions.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-slate-400">Overall CVR </span>
            <span className="text-slate-100 font-semibold">{formatPercent(overallCvr * 100)}</span>
          </div>
        </div>
      </div>

      {/* Winner banner */}
      {winner && winner.confidence !== null && winner.confidence >= 95 && (
        <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4">
          <Trophy size={20} className="text-green-400 flex-shrink-0" />
          <div>
            <p className="text-green-400 font-semibold text-sm">
              Winner: {winner.variant.name}
            </p>
            <p className="text-slate-400 text-xs mt-0.5">
              {formatPercent(winner.confidence)}% confidence this variant outperforms the control.
            </p>
          </div>
        </div>
      )}

      {/* Date filter + export */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-slate-400 text-sm">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="input-base w-36 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-400 text-sm">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="input-base w-36 text-sm"
          />
        </div>
        <button
          onClick={fetchAnalytics}
          disabled={loading}
          className="btn-secondary"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button onClick={exportCsv} className="btn-secondary ml-auto">
          <Download size={14} />
          Export CSV
        </button>
      </div>

      {/* Results table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700">
              <th className="text-left px-5 py-3 text-slate-400 font-medium">Variant</th>
              <th className="text-left px-5 py-3 text-slate-400 font-medium">Weight</th>
              <th className="text-right px-5 py-3 text-slate-400 font-medium">Views</th>
              <th className="text-right px-5 py-3 text-slate-400 font-medium">Conversions</th>
              <th className="text-right px-5 py-3 text-slate-400 font-medium">CVR</th>
              <th className="text-right px-5 py-3 text-slate-400 font-medium">Confidence</th>
              <th className="text-center px-5 py-3 text-slate-400 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                  <RefreshCw size={20} className="animate-spin mx-auto mb-2" />
                  Loading…
                </td>
              </tr>
            ) : stats.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                  No data yet. Activate this test to start collecting events.
                </td>
              </tr>
            ) : (
              stats.map((stat) => {
                const cvr = stat.cvr * 100;
                const control = stats.find((s) => s.variant.is_control);
                const controlCvr = (control?.cvr ?? 0) * 100;
                const uplift = !stat.variant.is_control && controlCvr > 0
                  ? ((cvr - controlCvr) / controlCvr) * 100
                  : null;

                return (
                  <tr
                    key={stat.variant.id}
                    className={`border-b border-slate-700/50 ${stat.isWinner ? 'bg-green-500/5' : ''}`}
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-200">{stat.variant.name}</span>
                        {stat.variant.is_control && (
                          <span className="badge bg-slate-700 text-slate-400 text-[10px]">control</span>
                        )}
                        {stat.isWinner && (
                          <Trophy size={13} className="text-green-400" />
                        )}
                        {stat.variant.redirect_url && getVerifiedStatus(stat.variant) === true && (
                          <span className="flex items-center gap-1 badge bg-green-500/20 text-green-400 border border-green-500/30 text-[10px]">
                            <ShieldCheck size={9} /> Verified
                          </span>
                        )}
                        {stat.variant.redirect_url && getVerifiedStatus(stat.variant) === false && (
                          <span className="flex items-center gap-1 badge bg-red-500/20 text-red-400 border border-red-500/30 text-[10px]">
                            <ShieldX size={9} /> Unverified
                          </span>
                        )}
                      </div>
                      {stat.variant.pages?.name && (
                        <p className="text-slate-500 text-xs mt-0.5">{stat.variant.pages.name}</p>
                      )}
                      {stat.variant.redirect_url && (
                        <div className="flex items-center gap-2 mt-1">
                          <p className="text-slate-500 text-xs font-mono truncate max-w-[200px]">{stat.variant.redirect_url}</p>
                          <button
                            onClick={() => checkTracking(stat.variant.id, stat.variant.redirect_url!)}
                            disabled={checkingTracking === stat.variant.id}
                            className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-200 transition-colors"
                          >
                            {checkingTracking === stat.variant.id ? (
                              <Loader2 size={9} className="animate-spin" />
                            ) : (
                              <ShieldCheck size={9} />
                            )}
                            Check
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-slate-400">{stat.variant.traffic_weight}%</td>
                    <td className="px-5 py-3.5 text-right text-slate-300">{stat.views.toLocaleString()}</td>
                    <td className="px-5 py-3.5 text-right text-slate-300">{stat.conversions.toLocaleString()}</td>
                    <td className="px-5 py-3.5 text-right font-semibold text-slate-100">{formatPercent(cvr)}</td>
                    <td className="px-5 py-3.5 text-right">
                      {stat.variant.is_control ? (
                        <span className="text-slate-500">—</span>
                      ) : stat.confidence !== null ? (
                        <span className={
                          stat.confidence >= 95 ? 'text-green-400 font-semibold' :
                          stat.confidence >= 80 ? 'text-amber-400' :
                          'text-slate-400'
                        }>
                          {formatPercent(stat.confidence)}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {uplift !== null && (
                        <span className={`flex items-center justify-center gap-1 text-xs font-medium ${uplift > 0 ? 'text-green-400' : 'text-red-400'}`}>
                          <TrendingUp size={12} className={uplift < 0 ? 'rotate-180' : ''} />
                          {uplift > 0 ? '+' : ''}{formatPercent(uplift)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {stats.length > 0 && (
        <p className="text-xs text-slate-500">
          Confidence is calculated using a chi-square test. 95%+ is considered statistically significant.
        </p>
      )}

      {/* Tracking Setup */}
      <div className="card overflow-hidden">
        <button
          onClick={() => setSnippetOpen(!snippetOpen)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-700/20 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center">
              <Code2 size={16} className="text-indigo-400" />
            </div>
            <div className="text-left">
              <p className="font-medium text-slate-200 text-sm">Tracking Setup</p>
              <p className="text-slate-500 text-xs">Paste this snippet into your external landing page to track conversions</p>
            </div>
          </div>
          {snippetOpen ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
        </button>

        {snippetOpen && (
          <div className="border-t border-slate-700 px-5 py-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-slate-400 text-xs">
                Paste this single line before <code className="text-indigo-300">&lt;/body&gt;</code> on your external site. No configuration needed.
                <span className="block mt-1 text-slate-500">
                  Tracking context is passed automatically via URL parameters. Form submissions and CTA button clicks are tracked as conversions.
                </span>
              </p>
              <button onClick={copySnippet} className="btn-secondary text-xs flex-shrink-0">
                <Copy size={12} /> Copy
              </button>
            </div>

            <pre className="bg-slate-900 border border-slate-700 rounded-lg p-4 overflow-x-auto text-xs text-slate-300 leading-relaxed">
              <code>{snippet}</code>
            </pre>

            {/* Check Tracking for redirect variants */}
            {variants.filter((v) => v.redirect_url).length > 0 && (
              <div>
                <p className="text-slate-400 text-xs font-medium mb-2">Tracking Verification</p>
                <div className="grid gap-1.5">
                  {variants.filter((v) => v.redirect_url).map((v) => {
                    const verified = getVerifiedStatus(v);
                    return (
                      <div key={v.id} className="flex items-center gap-2 text-xs">
                        <span className="text-slate-300 font-medium w-28 truncate">{v.name}</span>
                        {verified === true && (
                          <span className="flex items-center gap-1 badge bg-green-500/20 text-green-400 border border-green-500/30 text-[10px]">
                            <ShieldCheck size={9} /> Verified
                          </span>
                        )}
                        {verified === false && (
                          <span className="flex items-center gap-1 badge bg-red-500/20 text-red-400 border border-red-500/30 text-[10px]">
                            <ShieldX size={9} /> Not Found
                          </span>
                        )}
                        <button
                          onClick={() => checkTracking(v.id, v.redirect_url!)}
                          disabled={checkingTracking === v.id}
                          className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
                        >
                          {checkingTracking === v.id ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            <ShieldCheck size={10} />
                          )}
                          Check
                        </button>
                        <code className="text-slate-500 font-mono truncate max-w-[200px]">{v.redirect_url}</code>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {variants.length > 0 && (
              <div>
                <p className="text-slate-400 text-xs font-medium mb-2">Variant Reference</p>
                <div className="grid gap-1.5">
                  {variants.map((v) => (
                    <div key={v.id} className="flex items-center gap-2 text-xs">
                      <span className="text-slate-300 font-medium w-28 truncate">{v.name}</span>
                      {v.is_control && <span className="badge bg-slate-700 text-indigo-400 text-[10px]">control</span>}
                      <code className="text-slate-500 font-mono">{v.id}</code>
                      <button
                        onClick={() => { navigator.clipboard.writeText(v.id); toast.success('Variant ID copied'); }}
                        className="text-slate-600 hover:text-slate-300 transition-colors"
                      >
                        <Copy size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {goals.length > 0 && (
              <div>
                <p className="text-slate-400 text-xs font-medium mb-2">Goal Reference</p>
                <div className="grid gap-1.5">
                  {goals.map((g) => (
                    <div key={g.id} className="flex items-center gap-2 text-xs">
                      <span className="text-slate-300 font-medium w-28 truncate">{g.name}</span>
                      <span className="badge bg-slate-700 text-slate-400 text-[10px]">{g.type}</span>
                      {g.is_primary && <span className="badge bg-indigo-500/20 text-indigo-400 text-[10px]">primary</span>}
                      <code className="text-slate-500 font-mono">{g.id}</code>
                      <button
                        onClick={() => { navigator.clipboard.writeText(g.id); toast.success('Goal ID copied'); }}
                        className="text-slate-600 hover:text-slate-300 transition-colors"
                      >
                        <Copy size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
