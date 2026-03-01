'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Plus, FlaskConical, MoreHorizontal, Play, Pause, Check, Trash2, Link2, FileCode2, ShieldCheck, ShieldX, Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { TestStatusBadge } from '@/components/ui/Badge';

interface Page { id: string; name: string }
interface Variant { id: string; name: string; page_id: string | null; redirect_url: string | null; traffic_weight: number; is_control: boolean; tracking_verified?: boolean | null; tracking_verified_at?: string | null }
interface Goal { name: string; type: string; selector?: string; url_pattern?: string; is_primary: boolean }
interface Test {
  id: string;
  name: string;
  url_path: string;
  status: string;
  created_at: string;
  test_variants: Variant[];
  conversion_goals: Goal[];
}

interface Props {
  tests: Test[];
  pages: Page[];
  workspaceId: string;
  clientId: string;
  canManage: boolean;
}

const GOAL_TYPES = [
  { value: 'form_submit', label: 'Form Submit' },
  { value: 'button_click', label: 'Button Click' },
  { value: 'url_reached', label: 'URL Reached' },
  { value: 'call_click', label: 'Call Click' },
];

export default function TestsClient({ tests: initialTests, pages, workspaceId, clientId, canManage }: Props) {
  const router = useRouter();
  const [tests, setTests] = useState(initialTests);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [checkingTracking, setCheckingTracking] = useState<string | null>(null);

  // Form state
  const [testName, setTestName] = useState('');
  const [urlPath, setUrlPath] = useState('/');
  const [variants, setVariants] = useState([
    { name: 'Control', page_id: '', redirect_url: '', source_type: 'page' as 'page' | 'url', traffic_weight: 50, is_control: true },
    { name: 'Variant B', page_id: '', redirect_url: '', source_type: 'page' as 'page' | 'url', traffic_weight: 50, is_control: false },
  ]);
  const [goals, setGoals] = useState<Goal[]>([]);

  const totalWeight = variants.reduce((s, v) => s + v.traffic_weight, 0);

  function addVariant() {
    if (variants.length >= 5) return;
    const remaining = 100 - variants.reduce((s, v) => s + v.traffic_weight, 0);
    setVariants([...variants, { name: `Variant ${String.fromCharCode(66 + variants.length - 1)}`, page_id: '', redirect_url: '', source_type: 'page' as 'page' | 'url', traffic_weight: Math.max(remaining, 10), is_control: false }]);
  }

  function removeVariant(i: number) {
    if (variants.length <= 2) return;
    setVariants(variants.filter((_, idx) => idx !== i));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (totalWeight !== 100) {
      toast.error('Traffic weights must sum to 100%');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: testName,
          url_path: urlPath,
          variants: variants.map((v) => ({
            name: v.name,
            page_id: v.source_type === 'page' ? (v.page_id || null) : null,
            redirect_url: v.source_type === 'url' ? (v.redirect_url || null) : null,
            traffic_weight: v.traffic_weight,
            is_control: v.is_control,
          })),
          goals,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to create test');
        return;
      }
      const newTest = await res.json();
      setTests((prev) => [newTest, ...prev]);
      setModalOpen(false);
      resetForm();
      toast.success('Test created');
      router.refresh();
    } catch {
      toast.error('Unexpected error');
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setTestName('');
    setUrlPath('/');
    setVariants([
      { name: 'Control', page_id: '', redirect_url: '', source_type: 'page' as 'page' | 'url', traffic_weight: 50, is_control: true },
      { name: 'Variant B', page_id: '', redirect_url: '', source_type: 'page' as 'page' | 'url', traffic_weight: 50, is_control: false },
    ]);
    setGoals([]);
  }

  async function updateStatus(testId: string, status: string) {
    const res = await fetch(`/api/tests/${testId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      toast.error('Failed to update status');
      return;
    }
    setTests((prev) =>
      prev.map((t) => (t.id === testId ? { ...t, status } : t))
    );
    toast.success(`Test ${status}`);
    setActiveMenu(null);
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/tests/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Failed to delete test');
        return;
      }
      setTests((prev) => prev.filter((t) => t.id !== deleteId));
      toast.success('Test deleted');
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
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
      // Update the variant's tracking_verified status in local state
      setTests((prev) =>
        prev.map((t) => ({
          ...t,
          test_variants: (t.test_variants ?? []).map((v) =>
            v.id === variantId
              ? { ...v, tracking_verified: data.verified, tracking_verified_at: data.checked_at }
              : v
          ),
        }))
      );
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

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <p className="text-slate-400 text-sm">{tests.length} test{tests.length !== 1 ? 's' : ''}</p>
        {canManage && (
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={16} /> New Test
          </Button>
        )}
      </div>

      {tests.length === 0 && (
        <EmptyState
          icon={FlaskConical}
          title="No tests yet"
          description="Create an A/B test to start optimizing your landing pages."
          action={canManage ? <Button onClick={() => setModalOpen(true)}><Plus size={16} /> New Test</Button> : undefined}
        />
      )}

      {tests.length > 0 && (
        <div className="space-y-3">
          {tests.map((test) => (
            <div key={test.id} className="card p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1">
                    <h3 className="font-semibold text-slate-100">{test.name}</h3>
                    <TestStatusBadge status={test.status} />
                  </div>
                  <p className="text-slate-400 text-xs font-mono mb-3">{test.url_path}</p>
                  <div className="flex flex-wrap gap-2">
                    {(test.test_variants ?? []).map((v) => (
                      <span key={v.id} className="badge bg-slate-700 text-slate-300 gap-1">
                        {v.name}
                        <span className="text-slate-500">{v.traffic_weight}%</span>
                        {v.is_control && <span className="text-indigo-400 text-[10px]">ctrl</span>}
                        {v.redirect_url && <Link2 size={10} className="text-amber-400" />}
                        {v.redirect_url && v.tracking_verified === true && (
                          <ShieldCheck size={10} className="text-green-400" />
                        )}
                        {v.redirect_url && v.tracking_verified === false && (
                          <ShieldX size={10} className="text-red-400" />
                        )}
                      </span>
                    ))}
                  </div>
                  {/* Check Tracking buttons for redirect variants */}
                  {canManage && (test.test_variants ?? []).some((v) => v.redirect_url) && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {(test.test_variants ?? []).filter((v) => v.redirect_url).map((v) => (
                        <button
                          key={v.id}
                          onClick={() => checkTracking(v.id, v.redirect_url!)}
                          disabled={checkingTracking === v.id}
                          className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-200 bg-slate-700/50 hover:bg-slate-700 border border-slate-600/50 rounded-full px-2 py-0.5 transition-colors disabled:opacity-50"
                        >
                          {checkingTracking === v.id ? (
                            <Loader2 size={9} className="animate-spin" />
                          ) : v.tracking_verified === true ? (
                            <ShieldCheck size={9} className="text-green-400" />
                          ) : v.tracking_verified === false ? (
                            <ShieldX size={9} className="text-red-400" />
                          ) : (
                            <ShieldCheck size={9} />
                          )}
                          Check {v.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <Link
                    href={`/clients/${clientId}/tests/${test.id}`}
                    className="btn-secondary text-xs"
                  >
                    Analytics
                  </Link>
                  {canManage && (
                    <div className="relative">
                      <button
                        onClick={() => setActiveMenu(activeMenu === test.id ? null : test.id)}
                        className="btn-secondary p-2"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      {activeMenu === test.id && (
                        <div className="absolute right-0 top-full mt-1 w-44 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-10 overflow-hidden">
                          {test.status === 'draft' && (
                            <button onClick={() => updateStatus(test.id, 'active')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700">
                              <Play size={14} className="text-green-400" /> Activate
                            </button>
                          )}
                          {test.status === 'active' && (
                            <button onClick={() => updateStatus(test.id, 'paused')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700">
                              <Pause size={14} className="text-amber-400" /> Pause
                            </button>
                          )}
                          {test.status === 'paused' && (
                            <>
                              <button onClick={() => updateStatus(test.id, 'active')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700">
                                <Play size={14} className="text-green-400" /> Resume
                              </button>
                              <button onClick={() => updateStatus(test.id, 'completed')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700">
                                <Check size={14} className="text-blue-400" /> Complete
                              </button>
                            </>
                          )}
                          <button onClick={() => { setDeleteId(test.id); setActiveMenu(null); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-slate-700 border-t border-slate-700">
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create test modal */}
      <Modal open={modalOpen} onClose={() => { setModalOpen(false); resetForm(); }} title="New A/B Test" size="lg">
        <form onSubmit={handleCreate} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Test Name</label>
              <input type="text" value={testName} onChange={(e) => setTestName(e.target.value)} className="input-base" placeholder="Homepage Hero Test" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">URL Path</label>
              <input type="text" value={urlPath} onChange={(e) => setUrlPath(e.target.value)} className="input-base font-mono" placeholder="/" required />
            </div>
          </div>

          {/* Variants */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="section-label">Variants</label>
              <span className={`text-xs ${totalWeight === 100 ? 'text-green-400' : 'text-red-400'}`}>
                {totalWeight}% / 100%
              </span>
            </div>
            <div className="space-y-3">
              {variants.map((v, i) => (
                <div key={i} className="rounded-lg border border-slate-700 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input type="text" value={v.name} onChange={(e) => { const c = [...variants]; c[i].name = e.target.value; setVariants(c); }} className="input-base flex-1" placeholder="Variant name" required />
                    <input type="number" value={v.traffic_weight} onChange={(e) => { const c = [...variants]; c[i].traffic_weight = Number(e.target.value); setVariants(c); }} className="input-base w-20 text-center" min={1} max={100} />
                    <span className="text-slate-400 text-sm w-4">%</span>
                    {variants.length > 2 && (
                      <button type="button" onClick={() => removeVariant(i)} className="text-slate-500 hover:text-red-400 transition-colors">✕</button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex rounded-md overflow-hidden border border-slate-600">
                      <button type="button" onClick={() => { const c = [...variants]; c[i].source_type = 'page'; c[i].redirect_url = ''; setVariants(c); }} className={`px-2.5 py-1 text-xs flex items-center gap-1 ${v.source_type === 'page' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400 hover:text-slate-200'}`}>
                        <FileCode2 size={12} /> Page
                      </button>
                      <button type="button" onClick={() => { const c = [...variants]; c[i].source_type = 'url'; c[i].page_id = ''; setVariants(c); }} className={`px-2.5 py-1 text-xs flex items-center gap-1 ${v.source_type === 'url' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400 hover:text-slate-200'}`}>
                        <Link2 size={12} /> URL
                      </button>
                    </div>
                    {v.source_type === 'page' ? (
                      <select value={v.page_id} onChange={(e) => { const c = [...variants]; c[i].page_id = e.target.value; setVariants(c); }} className="input-base flex-1">
                        <option value="">Select a page</option>
                        {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    ) : (
                      <input type="url" value={v.redirect_url} onChange={(e) => { const c = [...variants]; c[i].redirect_url = e.target.value; setVariants(c); }} className="input-base flex-1 font-mono text-xs" placeholder="https://my-app.lovable.app/landing" />
                    )}
                  </div>
                </div>
              ))}
            </div>
            {variants.length < 5 && (
              <button type="button" onClick={addVariant} className="text-indigo-400 hover:text-indigo-300 text-sm mt-2">
                + Add variant
              </button>
            )}
          </div>

          {/* Goals */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="section-label">Conversion Goals</label>
              <button type="button" onClick={() => setGoals([...goals, { name: '', type: 'form_submit', selector: '', url_pattern: '', is_primary: goals.length === 0 }])} className="text-indigo-400 hover:text-indigo-300 text-sm">
                + Add goal
              </button>
            </div>
            <div className="space-y-3">
              {goals.map((g, i) => (
                <div key={i} className="rounded-lg border border-slate-700 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input type="text" value={g.name} onChange={(e) => { const c = [...goals]; c[i].name = e.target.value; setGoals(c); }} className="input-base flex-1" placeholder="Goal name" required />
                    <select value={g.type} onChange={(e) => { const c = [...goals]; c[i].type = e.target.value; c[i].selector = ''; c[i].url_pattern = ''; setGoals(c); }} className="input-base w-36">
                      {GOAL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <button type="button" onClick={() => setGoals(goals.filter((_, gi) => gi !== i))} className="text-slate-500 hover:text-red-400 transition-colors">✕</button>
                  </div>
                  <div className="flex items-center gap-2">
                    {(g.type === 'form_submit' || g.type === 'button_click') && (
                      <div className="flex-1">
                        <input
                          type="text"
                          value={g.selector || ''}
                          onChange={(e) => { const c = [...goals]; c[i].selector = e.target.value; setGoals(c); }}
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
                          onChange={(e) => { const c = [...goals]; c[i].url_pattern = e.target.value; setGoals(c); }}
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
                        onChange={(e) => { const c = [...goals]; c[i].is_primary = e.target.checked; setGoals(c); }}
                        className="rounded border-slate-600 bg-slate-700 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 w-3.5 h-3.5"
                      />
                      <span className="text-slate-400 text-xs">Primary</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
            {goals.length === 0 && (
              <p className="text-slate-500 text-xs mt-2">No goals configured. Add a goal to track conversions.</p>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => { setModalOpen(false); resetForm(); }}>Cancel</Button>
            <Button type="submit" loading={saving} disabled={totalWeight !== 100}>Create Test</Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete Test"
        description="This will permanently delete the test and all its event data. This cannot be undone."
        loading={deleting}
      />
    </>
  );
}
