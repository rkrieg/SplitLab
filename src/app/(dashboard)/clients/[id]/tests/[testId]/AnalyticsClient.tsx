'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Download, RefreshCw, Trophy, TrendingUp, Code2, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { TestStatusBadge } from '@/components/ui/Badge';
import { formatPercent } from '@/lib/utils';

interface Variant {
  id: string;
  name: string;
  is_control: boolean;
  traffic_weight: number;
  redirect_url?: string | null;
  pages?: { id: string; name: string } | null;
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

  function buildSnippet() {
    const goalsArray = goals.map((g) => {
      const obj: Record<string, string | null> = { type: g.type };
      if (g.id) obj.id = g.id;
      if (g.selector) obj.selector = g.selector;
      if (g.url_pattern) obj.urlPattern = g.url_pattern;
      return obj;
    });

    const lines = [
      `<!-- SplitLab Conversion Tracker -->`,
      `<script src="${appUrl}/tracker.js"></script>`,
      `<script>`,
      `  // Auto-detection: If visitors arrive via SplitLab redirect,`,
      `  // tracking starts automatically. For manual setup, use init():`,
    ];

    if (variants.length > 0) {
      lines.push(`  //`);
      lines.push(`  // Variant IDs for this test:`);
      variants.forEach((v) => {
        lines.push(`  //   ${v.name}${v.is_control ? ' (control)' : ''}: "${v.id}"`);
      });
    }

    lines.push(`  //`);
    lines.push(`  // Uncomment the init() call below if not using redirect-based tracking:`);
    lines.push(`  // SplitLab.init({ testId: "${test.id}", variantId: "VARIANT_ID_HERE" });`);

    if (goalsArray.length > 0) {
      lines.push(``);
      lines.push(`  // Register conversion goals for auto-tracking:`);
      lines.push(`  SplitLab.goals(${JSON.stringify(goalsArray, null, 4).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n')});`);
    }

    lines.push(``);
    lines.push(`  // Or fire conversions manually:`);
    lines.push(`  // SplitLab.track("conversion");`);
    if (goals.length > 0) {
      lines.push(`  // SplitLab.track("conversion", "${goals[0].id}");`);
    }
    lines.push(`</script>`);

    return lines.join('\n');
  }

  function copySnippet() {
    navigator.clipboard.writeText(buildSnippet());
    toast.success('Snippet copied to clipboard');
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
                      </div>
                      {stat.variant.pages?.name && (
                        <p className="text-slate-500 text-xs mt-0.5">{stat.variant.pages.name}</p>
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
                Add this code before <code className="text-indigo-300">&lt;/body&gt;</code> on your external site.
                {variants.some(v => v.redirect_url) && (
                  <span className="block mt-1 text-slate-500">
                    Since this test uses redirect URLs, tracking context is passed automatically via URL parameters.
                  </span>
                )}
              </p>
              <button onClick={copySnippet} className="btn-secondary text-xs flex-shrink-0">
                <Copy size={12} /> Copy
              </button>
            </div>

            <pre className="bg-slate-900 border border-slate-700 rounded-lg p-4 overflow-x-auto text-xs text-slate-300 leading-relaxed">
              <code>{buildSnippet()}</code>
            </pre>

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
