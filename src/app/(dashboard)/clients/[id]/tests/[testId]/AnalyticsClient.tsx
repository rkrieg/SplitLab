'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Download, RefreshCw, Trophy, TrendingUp, Code2, Copy, ChevronDown, ChevronUp, ShieldCheck, ShieldX, Loader2, Edit2 } from 'lucide-react';
import { TestStatusBadge } from '@/components/ui/Badge';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { formatPercent } from '@/lib/utils';

const GOAL_TYPES = [
  { value: 'form_submit', label: 'Form Submit' },
  { value: 'button_click', label: 'Button Click' },
  { value: 'url_reached', label: 'URL Reached' },
  { value: 'call_click', label: 'Call Click' },
];

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

export default function AnalyticsClient({ test: initialTest, appUrl }: Props) {
  const [test, setTest] = useState(initialTest);
  const [stats, setStats] = useState<VariantStat[]>([]);
  const [totalViews, setTotalViews] = useState(0);
  const [totalConversions, setTotalConversions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [checkingTracking, setCheckingTracking] = useState<string | null>(null);
  const [variantOverrides, setVariantOverrides] = useState<Record<string, { tracking_verified: boolean; tracking_verified_at: string }>>({});

  // Weight editing state
  const [editingWeights, setEditingWeights] = useState(false);
  const [weightDraft, setWeightDraft] = useState<Record<string, number>>({});
  const [savingWeights, setSavingWeights] = useState(false);

  // Edit state
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editUrlPath, setEditUrlPath] = useState('');
  const [editGoals, setEditGoals] = useState<Goal[]>([]);
  const [editSaving, setEditSaving] = useState(false);

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

  function openEdit() {
    setEditName(test.name);
    setEditUrlPath(test.url_path);
    setEditGoals((test.conversion_goals || []).map((g) => ({
      id: g.id,
      name: g.name,
      type: g.type,
      selector: g.selector || '',
      url_pattern: g.url_pattern || '',
      is_primary: g.is_primary,
    })));
    setEditOpen(true);
  }

  function closeEdit() {
    setEditOpen(false);
    setEditName('');
    setEditUrlPath('');
    setEditGoals([]);
  }

  function openWeightEdit() {
    const draft: Record<string, number> = {};
    for (const s of stats) {
      draft[s.variant.id] = s.variant.traffic_weight;
    }
    setWeightDraft(draft);
    setEditingWeights(true);
  }

  function cancelWeightEdit() {
    setEditingWeights(false);
    setWeightDraft({});
  }

  const weightSum = Object.values(weightDraft).reduce((s, v) => s + v, 0);

  async function saveWeights() {
    if (weightSum !== 100) {
      toast.error('Weights must sum to 100%');
      return;
    }
    setSavingWeights(true);
    try {
      const weights = Object.entries(weightDraft).map(([id, traffic_weight]) => ({ id, traffic_weight }));
      const res = await fetch(`/api/tests/${test.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weights }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to save weights');
        return;
      }
      const updated = await res.json();
      setTest(updated);
      setEditingWeights(false);
      setWeightDraft({});
      toast.success('Weights updated');
      fetchAnalytics();
    } catch {
      toast.error('Unexpected error');
    } finally {
      setSavingWeights(false);
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    setEditSaving(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editName,
          url_path: editUrlPath,
          goals: editGoals.map((g) => ({
            name: g.name,
            type: g.type,
            selector: g.selector || null,
            url_pattern: g.url_pattern || null,
            is_primary: g.is_primary,
          })),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to update test');
        return;
      }
      const updated = await res.json();
      setTest(updated);
      closeEdit();
      toast.success('Test updated');
    } catch {
      toast.error('Unexpected error');
    } finally {
      setEditSaving(false);
    }
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
        <button onClick={openEdit} className="btn-secondary ml-auto">
          <Edit2 size={14} />
          Edit
        </button>
        <button onClick={exportCsv} className="btn-secondary">
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
              <th className="text-left px-5 py-3 text-slate-400 font-medium">
                {editingWeights ? (
                  <div className="flex items-center gap-2">
                    <span>Weight</span>
                    <span className={`text-xs font-normal ${weightSum === 100 ? 'text-green-400' : 'text-red-400'}`}>
                      ({weightSum}%)
                    </span>
                    <button
                      onClick={saveWeights}
                      disabled={weightSum !== 100 || savingWeights}
                      className="px-2 py-0.5 rounded text-xs font-medium text-white disabled:opacity-50"
                      style={{ backgroundColor: '#3D8BDA' }}
                    >
                      {savingWeights ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={cancelWeightEdit} className="text-xs text-slate-500 hover:text-slate-300">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={openWeightEdit} className="hover:text-slate-200 transition-colors" title="Click to edit weights">
                    Weight
                  </button>
                )}
              </th>
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
                    <td className="px-5 py-3.5 text-slate-400">
                      {editingWeights ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={weightDraft[stat.variant.id] ?? stat.variant.traffic_weight}
                            onChange={(e) => setWeightDraft({ ...weightDraft, [stat.variant.id]: parseInt(e.target.value) || 0 })}
                            className="input-base w-16 text-sm text-center py-1 px-1.5"
                          />
                          <span className="text-xs">%</span>
                        </div>
                      ) : (
                        <button onClick={openWeightEdit} className="hover:text-slate-200 transition-colors">
                          {stat.variant.traffic_weight}%
                        </button>
                      )}
                    </td>
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

      {/* Edit test modal */}
      <Modal open={editOpen} onClose={closeEdit} title="Edit Test" size="lg">
        <form onSubmit={handleEdit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Test Name</label>
              <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="input-base" placeholder="Homepage Hero Test" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">URL Path</label>
              <input type="text" value={editUrlPath} onChange={(e) => setEditUrlPath(e.target.value)} className="input-base font-mono" placeholder="/" required />
            </div>
          </div>

          {/* Goals */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="section-label">Conversion Goals</label>
              <button type="button" onClick={() => setEditGoals([...editGoals, { id: '', name: '', type: 'form_submit', selector: '', url_pattern: '', is_primary: editGoals.length === 0 }])} className="text-indigo-400 hover:text-indigo-300 text-sm">
                + Add goal
              </button>
            </div>
            <div className="space-y-3">
              {editGoals.map((g, i) => (
                <div key={i} className="rounded-lg border border-slate-700 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input type="text" value={g.name} onChange={(e) => { const c = [...editGoals]; c[i].name = e.target.value; setEditGoals(c); }} className="input-base flex-1" placeholder="Goal name" required />
                    <select value={g.type} onChange={(e) => { const c = [...editGoals]; c[i].type = e.target.value; c[i].selector = ''; c[i].url_pattern = ''; setEditGoals(c); }} className="input-base w-36">
                      {GOAL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <button type="button" onClick={() => setEditGoals(editGoals.filter((_, gi) => gi !== i))} className="text-slate-500 hover:text-red-400 transition-colors">✕</button>
                  </div>
                  <div className="flex items-center gap-2">
                    {(g.type === 'form_submit' || g.type === 'button_click') && (
                      <div className="flex-1">
                        <input
                          type="text"
                          value={g.selector || ''}
                          onChange={(e) => { const c = [...editGoals]; c[i].selector = e.target.value; setEditGoals(c); }}
                          className="input-base w-full font-mono text-xs"
                          placeholder={g.type === 'form_submit' ? '#my-form or .contact-form' : '#cta-button or .signup-btn'}
                        />
                        <p className="text-slate-500 text-[10px] mt-1">CSS selector{g.type === 'form_submit' ? ' (blank = all forms)' : ''}</p>
                      </div>
                    )}
                    {g.type === 'url_reached' && (
                      <div className="flex-1">
                        <input
                          type="text"
                          value={g.url_pattern || ''}
                          onChange={(e) => { const c = [...editGoals]; c[i].url_pattern = e.target.value; setEditGoals(c); }}
                          className="input-base w-full font-mono text-xs"
                          placeholder="/thank-you or /success.*"
                        />
                        <p className="text-slate-500 text-[10px] mt-1">URL pattern (regex supported)</p>
                      </div>
                    )}
                    {g.type === 'call_click' && (
                      <p className="text-slate-500 text-xs flex-1">Automatically tracks clicks on tel: links</p>
                    )}
                    <label className="flex items-center gap-1.5 cursor-pointer flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={g.is_primary}
                        onChange={(e) => { const c = [...editGoals]; c[i].is_primary = e.target.checked; setEditGoals(c); }}
                        className="rounded border-slate-600 bg-slate-700 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 w-3.5 h-3.5"
                      />
                      <span className="text-slate-400 text-xs">Primary</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
            {editGoals.length === 0 && (
              <p className="text-slate-500 text-xs mt-2">No goals configured. Add a goal to track conversions.</p>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={closeEdit}>Cancel</Button>
            <Button type="submit" loading={editSaving}>Save Changes</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
