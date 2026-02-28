'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Plus, FlaskConical, MoreHorizontal, Play, Pause, Check, Trash2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { TestStatusBadge } from '@/components/ui/Badge';

interface Page { id: string; name: string }
interface Variant { id: string; name: string; page_id: string | null; traffic_weight: number; is_control: boolean }
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

  // Form state
  const [testName, setTestName] = useState('');
  const [urlPath, setUrlPath] = useState('/');
  const [variants, setVariants] = useState([
    { name: 'Control', page_id: '', traffic_weight: 50, is_control: true },
    { name: 'Variant B', page_id: '', traffic_weight: 50, is_control: false },
  ]);
  const [goals, setGoals] = useState<Goal[]>([]);

  const totalWeight = variants.reduce((s, v) => s + v.traffic_weight, 0);

  function addVariant() {
    if (variants.length >= 5) return;
    const remaining = 100 - variants.reduce((s, v) => s + v.traffic_weight, 0);
    setVariants([...variants, { name: `Variant ${String.fromCharCode(66 + variants.length - 1)}`, page_id: '', traffic_weight: Math.max(remaining, 10), is_control: false }]);
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
          variants: variants.map((v) => ({ ...v, page_id: v.page_id || null })),
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
      { name: 'Control', page_id: '', traffic_weight: 50, is_control: true },
      { name: 'Variant B', page_id: '', traffic_weight: 50, is_control: false },
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
                      </span>
                    ))}
                  </div>
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
            <div className="space-y-2">
              {variants.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="text" value={v.name} onChange={(e) => { const c = [...variants]; c[i].name = e.target.value; setVariants(c); }} className="input-base flex-1" placeholder="Variant name" required />
                  <select value={v.page_id} onChange={(e) => { const c = [...variants]; c[i].page_id = e.target.value; setVariants(c); }} className="input-base w-40">
                    <option value="">No page</option>
                    {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input type="number" value={v.traffic_weight} onChange={(e) => { const c = [...variants]; c[i].traffic_weight = Number(e.target.value); setVariants(c); }} className="input-base w-20 text-center" min={1} max={100} />
                  <span className="text-slate-400 text-sm w-4">%</span>
                  {variants.length > 2 && (
                    <button type="button" onClick={() => removeVariant(i)} className="text-slate-500 hover:text-red-400 transition-colors">✕</button>
                  )}
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
            {goals.map((g, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                <input type="text" value={g.name} onChange={(e) => { const c = [...goals]; c[i].name = e.target.value; setGoals(c); }} className="input-base flex-1" placeholder="Goal name" />
                <select value={g.type} onChange={(e) => { const c = [...goals]; c[i].type = e.target.value; setGoals(c); }} className="input-base w-36">
                  {GOAL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <input type="text" value={g.selector || ''} onChange={(e) => { const c = [...goals]; c[i].selector = e.target.value; setGoals(c); }} className="input-base w-28 font-mono text-xs" placeholder="#form-id" />
                <button type="button" onClick={() => setGoals(goals.filter((_, gi) => gi !== i))} className="text-slate-500 hover:text-red-400">✕</button>
              </div>
            ))}
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
