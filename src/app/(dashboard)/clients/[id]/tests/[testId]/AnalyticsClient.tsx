'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import {
  Download, RefreshCw, Trophy, TrendingUp, Code2, Copy,
  ChevronRight, ShieldCheck, ShieldX,
  Loader2, Globe, ExternalLink, Plus, Trash2, Check, X,
  Pencil, BarChart3, Users, Settings as SettingsIcon,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
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
  proxy_mode?: boolean;
  pages?: { id: string; name: string } | null;
  tracking_verified?: boolean | null;
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
  head_scripts?: string | null;
  test_variants?: Variant[];
  conversion_goals?: Goal[];
}

interface Lead {
  id: string;
  visitor_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
  test_variants: { name: string } | null;
  conversion_goals: { name: string } | null;
}

interface Props {
  test: Test;
  appUrl: string;
  clientId: string;
  clientName: string;
  domain?: string;
}

type Tab = 'overview' | 'leads' | 'settings';

export default function AnalyticsClient({ test: initialTest, appUrl, clientId, clientName, domain }: Props) {
  const [test, setTest] = useState(initialTest);
  const [tab, setTab] = useState<Tab>('overview');

  // Analytics
  const [stats, setStats] = useState<VariantStat[]>([]);
  const [totalViews, setTotalViews] = useState(0);
  const [totalConversions, setTotalConversions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Inline editing
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(test.name);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(test.url_path);
  const [savingField, setSavingField] = useState(false);

  // Variant editing
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [variantDraft, setVariantDraft] = useState({ name: '', redirect_url: '', proxy_mode: true });
  const [savingVariant, setSavingVariant] = useState(false);

  // Weight editing
  const [editingWeightId, setEditingWeightId] = useState<string | null>(null);
  const [weightDraft, setWeightDraft] = useState('');

  // Delete variant
  const [deleteVariantId, setDeleteVariantId] = useState<string | null>(null);
  const [deletingVariant, setDeletingVariant] = useState(false);

  // Add variant
  const [addVariantOpen, setAddVariantOpen] = useState(false);
  const [newVariantName, setNewVariantName] = useState('');
  const [newVariantUrl, setNewVariantUrl] = useState('');
  const [addingVariant, setAddingVariant] = useState(false);

  // Tracking verification
  const [checkingTracking, setCheckingTracking] = useState<string | null>(null);
  const [variantOverrides, setVariantOverrides] = useState<Record<string, boolean>>({});

  // Goals (settings tab)
  const [editGoals, setEditGoals] = useState<Goal[]>(() =>
    (initialTest.conversion_goals || []).map(g => ({ ...g, selector: g.selector || '', url_pattern: g.url_pattern || '' }))
  );
  const [savingGoals, setSavingGoals] = useState(false);

  // Head scripts (settings tab)
  const [headScriptsDraft, setHeadScriptsDraft] = useState(initialTest.head_scripts || '');
  const [savingScripts, setSavingScripts] = useState(false);

  // Leads
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsLoaded, setLeadsLoaded] = useState(false);

  // Computed
  const variants = test.test_variants || [];
  const snippet = `<script src="${appUrl}/tracker.js"></script>`;
  const fullUrl = domain ? `${domain}${test.url_path}` : null;

  // ─── Analytics ──────────────────────────────────────────────────────

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(`/api/tests/${test.id}/analytics?${params}`);
      if (!res.ok) throw new Error();
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

  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);

  const winner = stats.find(s => s.isWinner);
  const overallCvr = totalViews > 0 ? totalConversions / totalViews : 0;

  function exportCsv() {
    const headers = ['Variant', 'Control', 'Views', 'Conversions', 'CVR', 'Confidence', 'Winner'];
    const rows = stats.map(s => [
      s.variant.name, s.variant.is_control ? 'Yes' : 'No', s.views, s.conversions,
      formatPercent(s.cvr * 100), s.confidence !== null ? formatPercent(s.confidence) : 'N/A',
      s.isWinner ? 'Yes' : 'No',
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${test.name.replace(/\s+/g, '_')}_analytics.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Inline field saves ─────────────────────────────────────────────

  async function saveField(field: 'name' | 'url_path', value: string) {
    setSavingField(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) { toast.error('Failed to save'); return; }
      const updated = await res.json();
      setTest(updated);
      toast.success('Saved');
      if (field === 'name') setEditingName(false);
      if (field === 'url_path') setEditingPath(false);
    } catch { toast.error('Failed to save'); }
    finally { setSavingField(false); }
  }

  // ─── Status toggle ──────────────────────────────────────────────────

  async function toggleStatus() {
    const newStatus = test.status === 'active' ? 'paused' : 'active';
    const res = await fetch(`/api/tests/${test.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (!res.ok) { toast.error('Failed to update status'); return; }
    const updated = await res.json();
    setTest(updated);
    toast.success(newStatus === 'active' ? 'Published' : 'Unpublished');
  }

  // ─── Weight editing ─────────────────────────────────────────────────

  function startEditWeight(variantId: string, currentWeight: number) {
    setEditingWeightId(variantId);
    setWeightDraft(String(currentWeight));
  }

  async function saveWeight() {
    const variantId = editingWeightId;
    if (!variantId) return;
    const newWeight = Math.max(0, Math.min(100, Math.round(Number(weightDraft))));
    if (isNaN(newWeight)) { setEditingWeightId(null); return; }
    setEditingWeightId(null);

    const otherVariants = variants.filter(v => v.id !== variantId);
    const remaining = 100 - newWeight;
    const weights: { id: string; traffic_weight: number }[] = [
      { id: variantId, traffic_weight: newWeight },
    ];

    if (otherVariants.length === 0) {
      weights[0].traffic_weight = 100;
    } else {
      const currentOtherTotal = otherVariants.reduce((s, v) => s + v.traffic_weight, 0);
      if (currentOtherTotal === 0) {
        const each = Math.floor(remaining / otherVariants.length);
        let leftover = remaining - each * otherVariants.length;
        for (const v of otherVariants) {
          weights.push({ id: v.id, traffic_weight: each + (leftover-- > 0 ? 1 : 0) });
        }
      } else {
        let allocated = 0;
        for (let i = 0; i < otherVariants.length; i++) {
          const v = otherVariants[i];
          if (i === otherVariants.length - 1) {
            weights.push({ id: v.id, traffic_weight: remaining - allocated });
          } else {
            const w = Math.round((v.traffic_weight / currentOtherTotal) * remaining);
            weights.push({ id: v.id, traffic_weight: w });
            allocated += w;
          }
        }
      }
    }

    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weights }),
      });
      if (!res.ok) { toast.error('Weights must sum to 100'); return; }
      const updated = await res.json();
      setTest(updated);
      toast.success('Weights updated');
    } catch { toast.error('Failed to save weights'); }
  }

  // ─── Variant editing ────────────────────────────────────────────────

  function startEditVariant(v: Variant) {
    if (editingVariantId === v.id) { setEditingVariantId(null); return; }
    setEditingVariantId(v.id);
    setVariantDraft({
      name: v.name,
      redirect_url: v.redirect_url || '',
      proxy_mode: v.proxy_mode !== false,
    });
  }

  async function saveVariant(variantId: string) {
    setSavingVariant(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant_updates: [{
            id: variantId,
            name: variantDraft.name,
            redirect_url: variantDraft.redirect_url || null,
            proxy_mode: variantDraft.proxy_mode,
          }],
        }),
      });
      if (!res.ok) { toast.error('Failed to save variant'); return; }
      const updated = await res.json();
      setTest(updated);
      setEditingVariantId(null);
      toast.success('Variant updated');
    } catch { toast.error('Failed to save'); }
    finally { setSavingVariant(false); }
  }

  async function deleteVariant() {
    if (!deleteVariantId) return;
    setDeletingVariant(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete_variant_id: deleteVariantId }),
      });
      if (!res.ok) { toast.error('Failed to delete variant'); return; }
      const updated = await res.json();
      setTest(updated);
      setEditingVariantId(null);
      toast.success('Variant deleted');
      fetchAnalytics();
    } catch { toast.error('Failed to delete'); }
    finally { setDeletingVariant(false); setDeleteVariantId(null); }
  }

  // ─── Add variant ────────────────────────────────────────────────────

  async function handleAddVariant(e: React.FormEvent) {
    e.preventDefault();
    setAddingVariant(true);
    try {
      const count = variants.length + 1;
      const weight = Math.floor(100 / count);
      const remainder = 100 - weight * count;

      const res = await fetch(`/api/tests/${test.id}/variants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newVariantName, redirect_url: newVariantUrl,
          proxy_mode: true, traffic_weight: weight + remainder,
        }),
      });
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to add variant'); return; }
      const updated = await res.json();

      // Equalize weights
      const allVariants = updated.test_variants || [];
      const equalWeight = Math.floor(100 / allVariants.length);
      const rem = 100 - equalWeight * allVariants.length;
      const weights = allVariants.map((v: Variant, i: number) => ({
        id: v.id, traffic_weight: equalWeight + (i === 0 ? rem : 0),
      }));

      const wRes = await fetch(`/api/tests/${test.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weights }),
      });
      setTest(wRes.ok ? await wRes.json() : updated);
      setAddVariantOpen(false);
      setNewVariantName(''); setNewVariantUrl('');
      toast.success('Variant added');
      fetchAnalytics();
    } catch { toast.error('Failed to add variant'); }
    finally { setAddingVariant(false); }
  }

  // ─── Tracking check ─────────────────────────────────────────────────

  function getVerifiedStatus(v: Variant) {
    if (variantOverrides[v.id] !== undefined) return variantOverrides[v.id];
    return v.tracking_verified;
  }

  async function checkTracking(variantId: string, url: string) {
    setCheckingTracking(variantId);
    try {
      const res = await fetch('/api/check-tracking', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, variant_id: variantId }),
      });
      const data = await res.json();
      setVariantOverrides(prev => ({ ...prev, [variantId]: data.verified }));
      toast[data.verified ? 'success' : 'error'](data.verified ? 'Tracker verified' : 'Tracker not found');
    } catch { toast.error('Check failed'); }
    finally { setCheckingTracking(null); }
  }

  // ─── Goals ───────────────────────────────────────────────────────────

  async function handleSaveGoals(e: React.FormEvent) {
    e.preventDefault();
    setSavingGoals(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goals: editGoals.map(g => ({
            name: g.name, type: g.type,
            selector: g.selector || null, url_pattern: g.url_pattern || null,
            is_primary: g.is_primary,
          })),
        }),
      });
      if (!res.ok) { toast.error('Failed to save goals'); return; }
      const updated = await res.json();
      setTest(updated);
      setEditGoals((updated.conversion_goals || []).map((g: Goal) => ({ ...g, selector: g.selector || '', url_pattern: g.url_pattern || '' })));
      toast.success('Goals saved');
    } catch { toast.error('Failed to save'); }
    finally { setSavingGoals(false); }
  }

  // ─── Head Scripts ────────────────────────────────────────────────────

  async function saveHeadScripts() {
    setSavingScripts(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ head_scripts: headScriptsDraft || null }),
      });
      if (!res.ok) { toast.error('Failed to save'); return; }
      const updated = await res.json();
      setTest(updated);
      toast.success('Scripts saved');
    } catch { toast.error('Failed to save'); }
    finally { setSavingScripts(false); }
  }

  // ─── Leads ───────────────────────────────────────────────────────────

  const fetchLeads = useCallback(async () => {
    setLeadsLoading(true);
    try {
      const res = await fetch(`/api/tests/${test.id}/leads`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setLeads(data.leads || []);
      setLeadsLoaded(true);
    } catch { toast.error('Failed to load leads'); }
    finally { setLeadsLoading(false); }
  }, [test.id]);

  useEffect(() => {
    if (tab === 'leads' && !leadsLoaded) fetchLeads();
  }, [tab, leadsLoaded, fetchLeads]);

  // ─── Render ──────────────────────────────────────────────────────────

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: 'Overview', icon: <BarChart3 size={14} /> },
    { key: 'leads', label: 'Leads', icon: <Users size={14} /> },
    { key: 'settings', label: 'Settings', icon: <SettingsIcon size={14} /> },
  ];

  return (
    <div>
      {/* ═══ HEADER ═══ */}
      <div className="border-b border-slate-800 px-6 py-4 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-3">
          <Link href={`/clients/${clientId}/pages`} className="hover:text-slate-300 transition-colors">
            {clientName}
          </Link>
          <ChevronRight size={12} />
          <Link href={`/clients/${clientId}/pages`} className="hover:text-slate-300 transition-colors">
            Pages
          </Link>
          <ChevronRight size={12} />
          <span className="text-slate-400">{test.name}</span>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {editingName ? (
              <input
                type="text"
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                className="input-base text-lg font-semibold py-1 px-2 w-full max-w-md"
                autoFocus
                disabled={savingField}
                onKeyDown={e => {
                  if (e.key === 'Enter') saveField('name', nameDraft);
                  if (e.key === 'Escape') { setEditingName(false); setNameDraft(test.name); }
                }}
                onBlur={() => {
                  if (nameDraft.trim() && nameDraft !== test.name) saveField('name', nameDraft);
                  else { setEditingName(false); setNameDraft(test.name); }
                }}
              />
            ) : (
              <h1
                className="text-xl font-semibold text-slate-100 cursor-pointer hover:text-indigo-400 transition-colors inline-block"
                onClick={() => setEditingName(true)}
                title="Click to edit"
              >
                {test.name}
              </h1>
            )}

            <div className="flex items-center gap-2 mt-1">
              {editingPath ? (
                <div className="flex items-center gap-1">
                  {domain && <span className="text-slate-500 text-sm font-mono">{domain}</span>}
                  <input
                    type="text"
                    value={pathDraft}
                    onChange={e => setPathDraft(e.target.value)}
                    className="input-base font-mono text-sm py-0.5 px-1.5 w-48"
                    autoFocus
                    disabled={savingField}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveField('url_path', pathDraft);
                      if (e.key === 'Escape') { setEditingPath(false); setPathDraft(test.url_path); }
                    }}
                    onBlur={() => {
                      if (pathDraft.trim() && pathDraft !== test.url_path) saveField('url_path', pathDraft);
                      else { setEditingPath(false); setPathDraft(test.url_path); }
                    }}
                  />
                </div>
              ) : fullUrl ? (
                <div className="flex items-center gap-2">
                  <a
                    href={`https://${fullUrl}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
                  >
                    <Globe size={12} />
                    {fullUrl}
                    <ExternalLink size={10} />
                  </a>
                  <button onClick={() => setEditingPath(true)} className="text-slate-600 hover:text-slate-300 transition-colors p-0.5" title="Edit path">
                    <Pencil size={11} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setEditingPath(true)}
                  className="text-sm font-mono text-slate-400 hover:text-indigo-400 transition-colors"
                  title="Click to edit path"
                >
                  {test.url_path}
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 flex-shrink-0">
            <div className="flex items-center gap-4 text-sm border-r border-slate-700 pr-4">
              <div className="text-center">
                <p className="text-slate-100 font-semibold">{totalViews.toLocaleString()}</p>
                <p className="text-slate-500 text-[10px]">Views</p>
              </div>
              <div className="text-center">
                <p className="text-slate-100 font-semibold">{totalConversions.toLocaleString()}</p>
                <p className="text-slate-500 text-[10px]">Conversions</p>
              </div>
              <div className="text-center">
                <p className="text-slate-100 font-semibold">{formatPercent(overallCvr * 100)}</p>
                <p className="text-slate-500 text-[10px]">CVR</p>
              </div>
            </div>

            <button
              onClick={toggleStatus}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                test.status === 'active'
                  ? 'bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25'
                  : 'bg-green-500/15 border border-green-500/30 text-green-400 hover:bg-green-500/25'
              }`}
            >
              {test.status === 'active' ? 'Unpublish' : 'Publish'}
            </button>
          </div>
        </div>
      </div>

      {/* ═══ TABS ═══ */}
      <div className="border-b border-slate-800 px-6 flex">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══ TAB CONTENT ═══ */}
      <div className="p-6 space-y-6">

        {/* ─── OVERVIEW TAB ─── */}
        {tab === 'overview' && (
          <>
            {winner && winner.confidence !== null && winner.confidence >= 95 && (
              <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4">
                <Trophy size={20} className="text-green-400 flex-shrink-0" />
                <div>
                  <p className="text-green-400 font-semibold text-sm">Winner: {winner.variant.name}</p>
                  <p className="text-slate-400 text-xs mt-0.5">{formatPercent(winner.confidence)}% confidence</p>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-slate-400 text-sm">From</span>
                <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="input-base w-36 text-sm" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-400 text-sm">To</span>
                <input type="date" value={to} onChange={e => setTo(e.target.value)} className="input-base w-36 text-sm" />
              </div>
              <button onClick={fetchAnalytics} disabled={loading} className="btn-secondary">
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
              </button>
              <button onClick={exportCsv} className="btn-secondary ml-auto">
                <Download size={14} /> Export
              </button>
            </div>

            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700">
                    <th className="text-left px-5 py-3 text-slate-400 font-medium">Variant</th>
                    <th className="text-left px-5 py-3 text-slate-400 font-medium w-24">Weight</th>
                    <th className="text-right px-5 py-3 text-slate-400 font-medium">Views</th>
                    <th className="text-right px-5 py-3 text-slate-400 font-medium">Conversions</th>
                    <th className="text-right px-5 py-3 text-slate-400 font-medium">CVR</th>
                    <th className="text-right px-5 py-3 text-slate-400 font-medium">Confidence</th>
                    <th className="text-center px-5 py-3 text-slate-400 font-medium w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                        <RefreshCw size={20} className="animate-spin mx-auto mb-2" />Loading...
                      </td>
                    </tr>
                  ) : stats.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                        No data yet. Publish this page to start collecting events.
                      </td>
                    </tr>
                  ) : stats.map(stat => {
                    const cvr = stat.cvr * 100;
                    const control = stats.find(s => s.variant.is_control);
                    const controlCvr = (control?.cvr ?? 0) * 100;
                    const uplift = !stat.variant.is_control && controlCvr > 0
                      ? ((cvr - controlCvr) / controlCvr) * 100 : null;
                    const isEditing = editingVariantId === stat.variant.id;
                    const verified = getVerifiedStatus(stat.variant);
                    const rowBg = stat.isWinner ? 'bg-green-500/5' : '';

                    return (
                      <Fragment key={stat.variant.id}>
                        <tr className={`group ${rowBg}`}>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-slate-200">{stat.variant.name}</span>
                              {stat.variant.is_control && <span className="badge bg-slate-700 text-slate-400 text-[10px]">control</span>}
                              {stat.isWinner && <Trophy size={13} className="text-green-400" />}
                              {stat.variant.redirect_url && (
                                verified === true ? <ShieldCheck size={11} className="text-green-400" /> :
                                verified === false ? <ShieldX size={11} className="text-red-400" /> : null
                              )}
                            </div>
                            {stat.variant.redirect_url && !isEditing && (
                              <p className="text-slate-500 text-xs font-mono truncate max-w-[250px] mt-0.5">
                                {stat.variant.redirect_url}
                              </p>
                            )}
                          </td>
                          <td className={`px-5 py-3.5 ${rowBg}`}>
                            {editingWeightId === stat.variant.id ? (
                              <input
                                type="number"
                                value={weightDraft}
                                onChange={e => setWeightDraft(e.target.value)}
                                className="input-base w-16 text-sm text-center py-0.5"
                                min={0} max={100}
                                autoFocus
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveWeight();
                                  if (e.key === 'Escape') setEditingWeightId(null);
                                }}
                                onBlur={saveWeight}
                              />
                            ) : (
                              <button
                                onClick={() => startEditWeight(stat.variant.id, stat.variant.traffic_weight)}
                                className="text-slate-400 hover:text-indigo-400 transition-colors cursor-pointer"
                                title="Click to edit weight"
                              >
                                {stat.variant.traffic_weight}%
                              </button>
                            )}
                          </td>
                          <td className={`px-5 py-3.5 text-right text-slate-300 ${rowBg}`}>{stat.views.toLocaleString()}</td>
                          <td className={`px-5 py-3.5 text-right text-slate-300 ${rowBg}`}>{stat.conversions.toLocaleString()}</td>
                          <td className={`px-5 py-3.5 text-right font-semibold text-slate-100 ${rowBg}`}>{formatPercent(cvr)}</td>
                          <td className={`px-5 py-3.5 text-right ${rowBg}`}>
                            {stat.variant.is_control ? <span className="text-slate-500">—</span> :
                             stat.confidence !== null ? (
                              <span className={stat.confidence >= 95 ? 'text-green-400 font-semibold' : stat.confidence >= 80 ? 'text-amber-400' : 'text-slate-400'}>
                                {formatPercent(stat.confidence)}
                              </span>
                            ) : <span className="text-slate-500">—</span>}
                          </td>
                          <td className={`px-5 py-3.5 text-center ${rowBg}`}>
                            <div className="flex items-center justify-center gap-1">
                              {uplift !== null && (
                                <span className={`flex items-center gap-0.5 text-xs font-medium ${uplift > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                  <TrendingUp size={11} className={uplift < 0 ? 'rotate-180' : ''} />
                                  {uplift > 0 ? '+' : ''}{formatPercent(uplift)}
                                </span>
                              )}
                              <button
                                onClick={() => startEditVariant(stat.variant)}
                                className={`p-1 rounded transition-colors ${isEditing ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-600 hover:text-slate-300'}`}
                                title="Edit variant"
                              >
                                <Pencil size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>

                        {isEditing && (
                          <tr>
                            <td colSpan={7} className="border-t border-slate-700 bg-slate-800/50 px-6 py-4">
                              <div className="grid grid-cols-2 gap-4 max-w-2xl">
                                <div>
                                  <label className="block text-xs font-medium text-slate-400 mb-1">Variant Name</label>
                                  <input
                                    type="text"
                                    value={variantDraft.name}
                                    onChange={e => setVariantDraft({ ...variantDraft, name: e.target.value })}
                                    className="input-base text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-slate-400 mb-1">Destination URL</label>
                                  <input
                                    type="url"
                                    value={variantDraft.redirect_url}
                                    onChange={e => setVariantDraft({ ...variantDraft, redirect_url: e.target.value })}
                                    className="input-base text-sm font-mono"
                                    placeholder="https://..."
                                  />
                                </div>
                              </div>

                              <div className="flex items-center gap-4 mt-3">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-slate-400">Mode:</span>
                                  <button
                                    onClick={() => setVariantDraft({ ...variantDraft, proxy_mode: !variantDraft.proxy_mode })}
                                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border transition-colors ${
                                      variantDraft.proxy_mode
                                        ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
                                        : 'bg-slate-700 text-slate-400 border-slate-600'
                                    }`}
                                  >
                                    {variantDraft.proxy_mode ? <><Globe size={11} /> Proxy</> : <><ExternalLink size={11} /> Redirect</>}
                                  </button>
                                </div>

                                {variantDraft.redirect_url && (
                                  <a href={variantDraft.redirect_url} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs">
                                    <ExternalLink size={12} /> Preview
                                  </a>
                                )}

                                {variantDraft.redirect_url && (
                                  <button
                                    onClick={() => checkTracking(stat.variant.id, variantDraft.redirect_url)}
                                    disabled={checkingTracking === stat.variant.id}
                                    className="btn-secondary text-xs"
                                  >
                                    {checkingTracking === stat.variant.id ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                                    Check Tracker
                                  </button>
                                )}

                                <div className="ml-auto flex items-center gap-2">
                                  {variants.length > 1 && (
                                    <button
                                      onClick={() => setDeleteVariantId(stat.variant.id)}
                                      className="btn-secondary text-xs text-red-400 hover:text-red-300"
                                    >
                                      <Trash2 size={12} /> Delete
                                    </button>
                                  )}
                                  <Button size="sm" onClick={() => saveVariant(stat.variant.id)} loading={savingVariant}>
                                    <Check size={12} /> Save
                                  </Button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>

              <div className="border-t border-slate-700 px-5 py-3">
                <button
                  onClick={() => {
                    setNewVariantName(`Variant ${String.fromCharCode(65 + variants.length)}`);
                    setNewVariantUrl('');
                    setAddVariantOpen(true);
                  }}
                  className="text-indigo-400 hover:text-indigo-300 text-sm font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Plus size={14} /> Add Variant
                </button>
              </div>
            </div>

            {stats.length > 0 && (
              <p className="text-xs text-slate-500">
                Confidence is calculated using a chi-square test. 95%+ is considered statistically significant.
              </p>
            )}
          </>
        )}

        {/* ─── LEADS TAB ─── */}
        {tab === 'leads' && (
          <>
            {leadsLoading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw size={20} className="animate-spin text-slate-400" />
              </div>
            ) : leads.length === 0 ? (
              <div className="text-center py-12">
                <Users size={32} className="mx-auto text-slate-600 mb-3" />
                <p className="text-slate-400 text-sm">No conversions recorded yet.</p>
                <p className="text-slate-500 text-xs mt-1">Conversions will appear here once visitors trigger your goals.</p>
              </div>
            ) : (
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
                  <p className="text-sm text-slate-400">{leads.length} conversion{leads.length !== 1 ? 's' : ''}</p>
                  <button onClick={fetchLeads} className="btn-secondary text-xs">
                    <RefreshCw size={12} /> Refresh
                  </button>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700">
                      <th className="text-left px-5 py-3 text-slate-400 font-medium">Date</th>
                      <th className="text-left px-5 py-3 text-slate-400 font-medium">Visitor</th>
                      <th className="text-left px-5 py-3 text-slate-400 font-medium">Variant</th>
                      <th className="text-left px-5 py-3 text-slate-400 font-medium">Goal</th>
                      <th className="text-left px-5 py-3 text-slate-400 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map(lead => (
                      <tr key={lead.id} className="border-b border-slate-800 last:border-0">
                        <td className="px-5 py-3 text-slate-300 text-xs">
                          {new Date(lead.created_at).toLocaleString()}
                        </td>
                        <td className="px-5 py-3 text-slate-500 font-mono text-xs">
                          {lead.visitor_hash.slice(0, 8)}...
                        </td>
                        <td className="px-5 py-3 text-slate-300">
                          {lead.test_variants?.name || '—'}
                        </td>
                        <td className="px-5 py-3 text-slate-300">
                          {lead.conversion_goals?.name || '—'}
                        </td>
                        <td className="px-5 py-3 text-slate-500 text-xs font-mono">
                          {(lead.metadata as Record<string, string>)?.trigger || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ─── SETTINGS TAB ─── */}
        {tab === 'settings' && (
          <>
            {/* Conversion Goals */}
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-slate-200">Conversion Goals</h3>
                  <button
                    type="button"
                    onClick={() => setEditGoals([...editGoals, { id: '', name: '', type: 'form_submit', selector: '', url_pattern: '', is_primary: editGoals.length === 0 }])}
                    className="text-indigo-400 hover:text-indigo-300 text-sm"
                  >
                    + Add Goal
                  </button>
                </div>
              </div>
              <form onSubmit={handleSaveGoals} className="px-5 py-4 space-y-3">
                {editGoals.map((g, i) => (
                  <div key={i} className="rounded-lg border border-slate-700 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={g.name}
                        onChange={e => { const c = [...editGoals]; c[i] = { ...c[i], name: e.target.value }; setEditGoals(c); }}
                        className="input-base flex-1"
                        placeholder="Goal name"
                        required
                      />
                      <select
                        value={g.type}
                        onChange={e => { const c = [...editGoals]; c[i] = { ...c[i], type: e.target.value, selector: '', url_pattern: '' }; setEditGoals(c); }}
                        className="input-base w-36"
                      >
                        {GOAL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <button type="button" onClick={() => setEditGoals(editGoals.filter((_, gi) => gi !== i))} className="text-slate-500 hover:text-red-400 transition-colors">
                        <X size={14} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      {(g.type === 'form_submit' || g.type === 'button_click') && (
                        <input
                          type="text"
                          value={g.selector || ''}
                          onChange={e => { const c = [...editGoals]; c[i] = { ...c[i], selector: e.target.value }; setEditGoals(c); }}
                          className="input-base flex-1 font-mono text-xs"
                          placeholder={g.type === 'form_submit' ? '#my-form' : '#cta-button'}
                        />
                      )}
                      {g.type === 'url_reached' && (
                        <input
                          type="text"
                          value={g.url_pattern || ''}
                          onChange={e => { const c = [...editGoals]; c[i] = { ...c[i], url_pattern: e.target.value }; setEditGoals(c); }}
                          className="input-base flex-1 font-mono text-xs"
                          placeholder="/thank-you"
                        />
                      )}
                      {g.type === 'call_click' && <p className="text-slate-500 text-xs flex-1">Tracks tel: link clicks</p>}
                      <label className="flex items-center gap-1.5 cursor-pointer flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={g.is_primary}
                          onChange={e => { const c = [...editGoals]; c[i] = { ...c[i], is_primary: e.target.checked }; setEditGoals(c); }}
                          className="rounded border-slate-600 bg-slate-700 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 w-3.5 h-3.5"
                        />
                        <span className="text-slate-400 text-xs">Primary</span>
                      </label>
                    </div>
                  </div>
                ))}
                {editGoals.length === 0 && <p className="text-slate-500 text-xs">No goals. Add one to track conversions.</p>}
                <div className="flex justify-end pt-2">
                  <Button type="submit" loading={savingGoals} size="sm">Save Goals</Button>
                </div>
              </form>
            </div>

            {/* Tracking Setup */}
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-700">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center">
                    <Code2 size={16} className="text-indigo-400" />
                  </div>
                  <div>
                    <p className="font-medium text-slate-200 text-sm">Tracking Snippet</p>
                    <p className="text-slate-500 text-xs">Paste before &lt;/body&gt; on your external landing page (redirect mode only)</p>
                  </div>
                </div>
              </div>
              <div className="px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-slate-400 text-xs">Tracking context is passed via URL parameters.</p>
                  <button onClick={() => { navigator.clipboard.writeText(snippet); toast.success('Copied'); }} className="btn-secondary text-xs">
                    <Copy size={12} /> Copy
                  </button>
                </div>
                <pre className="bg-slate-900 border border-slate-700 rounded-lg p-4 overflow-x-auto text-xs text-slate-300">
                  <code>{snippet}</code>
                </pre>
              </div>
            </div>

            {/* Head Scripts (for proxy mode) */}
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-700">
                <h3 className="font-medium text-slate-200">Head Scripts</h3>
                <p className="text-slate-500 text-xs mt-1">
                  Custom scripts injected in the parent frame for proxy mode. Use this for Meta Pixel, Google Analytics, etc.
                </p>
              </div>
              <div className="px-5 py-4 space-y-3">
                <textarea
                  value={headScriptsDraft}
                  onChange={e => setHeadScriptsDraft(e.target.value)}
                  className="input-base font-mono text-xs w-full h-32 resize-y"
                  placeholder={'<!-- Meta Pixel -->\n<script>...</script>\n\n<!-- Google Analytics -->\n<script>...</script>'}
                />
                <div className="flex justify-end">
                  <Button onClick={saveHeadScripts} loading={savingScripts} size="sm">Save Scripts</Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ═══ MODALS ═══ */}
      <Modal open={addVariantOpen} onClose={() => setAddVariantOpen(false)} title="Add Variant" size="sm">
        <form onSubmit={handleAddVariant} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Variant Name</label>
            <input type="text" value={newVariantName} onChange={e => setNewVariantName(e.target.value)} className="input-base" required autoFocus />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Destination URL</label>
            <input type="url" value={newVariantUrl} onChange={e => setNewVariantUrl(e.target.value)} className="input-base font-mono text-sm" placeholder="https://..." required />
          </div>
          <p className="text-slate-500 text-xs">Traffic weights will be automatically split equally across all variants.</p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => setAddVariantOpen(false)}>Cancel</Button>
            <Button type="submit" loading={addingVariant}>Add Variant</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleteVariantId}
        onClose={() => setDeleteVariantId(null)}
        onConfirm={deleteVariant}
        title="Delete Variant"
        description="This will permanently delete the variant and its event data. Traffic weights will need to be adjusted."
        loading={deletingVariant}
      />
    </div>
  );
}
