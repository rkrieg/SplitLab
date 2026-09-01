'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  Plus, FileCode2, MoreHorizontal, Play, Pause, Check, Trash2,
  Globe, Link2, ShieldCheck, ShieldX, Edit2, Info, Copy,
} from 'lucide-react';
import Spinner from '@/components/ui/Spinner';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { TestStatusBadge } from '@/components/ui/Badge';

interface Variant {
  id: string;
  name: string;
  redirect_url: string | null;
  proxy_mode: boolean;
  traffic_weight: number;
  is_control: boolean;
  tracking_verified?: boolean | null;
}
interface Goal { id?: string; name: string; type: string; selector?: string; url_pattern?: string; is_primary: boolean }
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
  workspaceId: string;
  clientId: string;
  canManage: boolean;
  domain?: string;
}

export default function PagesClient({ tests: initialTests, workspaceId, clientId, canManage, domain }: Props) {
  const router = useRouter();
  const [tests, setTests] = useState(initialTests);

  // Follow refreshed server data — router.refresh() after mutations re-renders
  // the server component, and this keeps local state in sync with it.
  useEffect(() => {
    setTests(initialTests);
  }, [initialTests]);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [checkingTracking, setCheckingTracking] = useState<string | null>(null);
  const [updatingStatusId, setUpdatingStatusId] = useState<string | null>(null);

  // Create form
  const [pageName, setPageName] = useState('');
  const [urlPath, setUrlPath] = useState('/');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [createMode, setCreateMode] = useState<'url' | 'html' | 'ai'>('url');
  const [createHtml, setCreateHtml] = useState('');

  // Edit state
  const [editTestId, setEditTestId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrlPath, setEditUrlPath] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Add variant state
  const [addVariantTestId, setAddVariantTestId] = useState<string | null>(null);
  const [variantName, setVariantName] = useState('');
  const [variantUrl, setVariantUrl] = useState('');
  const [addingVariant, setAddingVariant] = useState(false);
  const [variantMode, setVariantMode] = useState<'url' | 'html'>('url');
  const [variantHtml, setVariantHtml] = useState('');

  // Duplicate state
  const [duplicateTest, setDuplicateTest] = useState<Test | null>(null);
  const [dupName, setDupName] = useState('');
  const [dupPath, setDupPath] = useState('');
  const [duplicating, setDuplicating] = useState(false);

  // Modal errors
  const [createPageError, setCreatePageError] = useState<{ message: string; isLimit: boolean } | null>(null);
  const [addVariantError, setAddVariantError] = useState<{ message: string; isLimit: boolean } | null>(null);

  async function checkFrameable(url: string): Promise<boolean> {
    if (!url.startsWith('http')) return true;
    try {
      const res = await fetch(`/api/check-frameable?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      return data.frameable !== false;
    } catch {
      return true;
    }
  }

  // ─── Create Page ────────────────────────────────────────────────────────

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      // Build-with-AI: create a blank AI page + a draft test at this path with
      // that page as the control variant, then hand off to the AI editor to
      // actually build the page. The draft test already exists at the path, so
      // once they build and activate, it serves.
      if (createMode === 'ai') {
        const pageRes = await fetch('/api/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspaceId, name: pageName.trim(), vertical: 'lead_gen' }),
        });
        if (!pageRes.ok) {
          const err = await pageRes.json().catch(() => ({}));
          const msg = err.error || 'Could not start AI page';
          toast.error(msg);
          setCreatePageError({ message: msg, isLimit: !!err.limitError });
          return;
        }
        const page = await pageRes.json();
        // Register a draft test at the chosen path with the new page as control.
        const testRes = await fetch(`/api/workspaces/${workspaceId}/tests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: pageName.trim(),
            url_path: urlPath,
            status: 'draft',
            variants: [{ name: 'Control', page_id: page.id, traffic_weight: 100, is_control: true }],
          }),
        });
        // Without the test the page has no path to serve on, so stay in the
        // modal with the real reason (taken path, plan limit) rather than
        // dropping the user into the AI editor with an orphaned page.
        if (!testRes.ok) {
          const err = await testRes.json().catch(() => ({}));
          const msg = err.error || 'Could not reserve that path for the AI page';
          toast.error(msg);
          setCreatePageError({ message: msg, isLimit: !!err.limitError });
          return;
        }
        router.push(`/clients/${clientId}/ai-pages/new?page_id=${page.id}`);
        return;
      }

      let res: Response;
      if (createMode === 'html') {
        res = await fetch('/api/pages/from-html', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: pageName,
            html_content: createHtml,
            workspace_id: workspaceId,
            url_path: urlPath,
          }),
        });
      } else {
        const normalizedUrl = destinationUrl.match(/^https?:\/\//) ? destinationUrl : `https://${destinationUrl}`;
        const proxyMode = await checkFrameable(normalizedUrl);
        res = await fetch(`/api/workspaces/${workspaceId}/tests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: pageName,
            url_path: urlPath,
            variants: [{
              name: 'Control',
              redirect_url: normalizedUrl,
              proxy_mode: proxyMode,
              traffic_weight: 100,
              is_control: true,
            }],
          }),
        });
      }
      if (!res.ok) {
        const err = await res.json();
        const msg = err.error || 'Failed to create page';
        toast.error(msg);
        setCreatePageError({ message: msg, isLimit: !!err.limitError });
        return;
      }
      const created = await res.json();
      setTests((prev) => [created, ...prev]);
      router.refresh();
      toast.success('Page created');
      setCreateOpen(false);
      resetCreateForm();
    } catch {
      toast.error('Unexpected error');
    } finally {
      setSaving(false);
    }
  }

  function resetCreateForm() {
    setPageName('');
    setUrlPath('/');
    setDestinationUrl('');
    setCreateMode('url');
    setCreateHtml('');
    setCreatePageError(null);
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  async function updateStatus(testId: string, status: string) {
    setUpdatingStatusId(testId);
    setActiveMenu(null);
    try {
      const res = await fetch(`/api/tests/${testId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) { const err = await res.json().catch(() => null); toast.error(err?.error || 'Failed to update status'); return; }
      setTests((prev) => prev.map((t) => (t.id === testId ? { ...t, status } : t)));
      router.refresh();
      toast.success(`Page ${status}`);
    } finally {
      setUpdatingStatusId(null);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/tests/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) { toast.error('Failed to delete'); return; }
      setTests((prev) => prev.filter((t) => t.id !== deleteId));
      router.refresh();
      toast.success('Page deleted');
    } finally { setDeleting(false); setDeleteId(null); }
  }

  // ─── Duplicate ────────────────────────────────────────────────────────────
  function openDuplicate(test: Test) {
    setDuplicateTest(test);
    setDupName(`${test.name} (copy)`);
    // Default a distinct suffix so the copy is immediately servable without a clash.
    setDupPath(test.url_path === '/' ? '/copy' : `${test.url_path}-copy`);
    setActiveMenu(null);
  }

  async function handleDuplicate(e: React.FormEvent) {
    e.preventDefault();
    if (!duplicateTest) return;
    setDuplicating(true);
    try {
      const res = await fetch(`/api/tests/${duplicateTest.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dupName.trim(), url_path: dupPath.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to duplicate page');
        return;
      }
      const created = await res.json();
      setTests((prev) => [created, ...prev]);
      router.refresh();
      toast.success('Page duplicated');
      setDuplicateTest(null);
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setDuplicating(false);
    }
  }

  // ─── Edit ───────────────────────────────────────────────────────────────

  function openEditModal(test: Test) {
    setEditTestId(test.id);
    setEditName(test.name);
    setEditUrlPath(test.url_path);
    setActiveMenu(null);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTestId) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/tests/${editTestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, url_path: editUrlPath }),
      });
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to update'); return; }
      const updated = await res.json();
      setTests((prev) => prev.map((t) => (t.id === editTestId ? { ...t, ...updated } : t)));
      setEditTestId(null);
      toast.success('Page updated');
      router.refresh();
    } catch { toast.error('Unexpected error'); } finally { setEditSaving(false); }
  }

  // ─── Add Variant ────────────────────────────────────────────────────────

  function openAddVariant(test: Test) {
    setAddVariantTestId(test.id);
    const count = (test.test_variants ?? []).length;
    setVariantName(`Variant ${String.fromCharCode(65 + count)}`);
    setVariantUrl('');
    setVariantMode('url');
    setVariantHtml('');
    setActiveMenu(null);
  }

  async function handleAddVariant(e: React.FormEvent) {
    e.preventDefault();
    if (!addVariantTestId) return;
    setAddingVariant(true);
    try {
      const proxyMode = variantMode === 'url' ? await checkFrameable(variantUrl.trim()) : true;
      const payload = variantMode === 'html'
        ? { name: variantName, html_content: variantHtml }
        : { name: variantName, redirect_url: variantUrl, proxy_mode: proxyMode };
      const res = await fetch(`/api/tests/${addVariantTestId}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        const msg = err.error || 'Failed to add variant';
        toast.error(msg);
        setAddVariantError({ message: msg, isLimit: !!err.limitError });
        return;
      }
      const updated = await res.json();
      setTests((prev) => prev.map((t) => (t.id === addVariantTestId ? updated : t)));
      router.refresh();
      setAddVariantTestId(null);
      setAddVariantError(null);
      toast.success('Variant added at 0% traffic — set its weight to send traffic to it');
    } catch { toast.error('Unexpected error'); } finally { setAddingVariant(false); }
  }

  // ─── Tracking Check ────────────────────────────────────────────────────

  async function checkTracking(variantId: string, url: string) {
    setCheckingTracking(variantId);
    try {
      const res = await fetch('/api/check-tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, variant_id: variantId }),
      });
      const data = await res.json();
      setTests((prev) =>
        prev.map((t) => ({
          ...t,
          test_variants: (t.test_variants ?? []).map((v) =>
            v.id === variantId
              ? { ...v, tracking_verified: data.verified }
              : v
          ),
        }))
      );
      if (data.verified) toast.success('Tracker verified');
      else toast.error('Tracker not found on target page');
    } catch { toast.error('Failed to check tracking'); } finally { setCheckingTracking(null); }
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <p className="text-slate-500 dark:text-slate-400 text-sm">{tests.length} page{tests.length !== 1 ? 's' : ''}</p>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> New Page
            </Button>
          </div>
        )}
      </div>

      {tests.length === 0 && (
        <EmptyState
          icon={FileCode2}
          title="No pages yet"
          description="Create a page to start routing traffic through your custom domain."
          action={canManage ? <Button onClick={() => setCreateOpen(true)}><Plus size={16} /> New Page</Button> : undefined}
        />
      )}

      {tests.length > 0 && (
        <div className="space-y-3">
          {tests.map((test) => {
            const variantCount = (test.test_variants ?? []).length;
            const fullUrl = domain ? `${domain}${test.url_path}` : test.url_path;

            return (
              <div
                key={test.id}
                className="card p-5 cursor-pointer hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                onClick={() => router.push(`/clients/${clientId}/tests/${test.id}`)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="font-semibold text-slate-900 dark:text-slate-100">{test.name}</h3>
                      <TestStatusBadge status={test.status} />
                      {variantCount > 1 && (
                        <span className="text-slate-400 dark:text-slate-500 text-xs">{variantCount} variants</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mb-3">
                      {domain ? (
                        <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 font-mono">
                          <Globe size={12} className="text-green-600 dark:text-green-400" />
                          {fullUrl}
                        </span>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400 text-xs font-mono">{test.url_path}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(test.test_variants ?? []).map((v) => (
                        <span key={v.id} className="badge bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 gap-1">
                          {v.name}
                          <span className="text-slate-400 dark:text-slate-500">{v.traffic_weight}%</span>
                          {v.is_control && <span className="text-indigo-600 dark:text-indigo-400 text-[10px]">ctrl</span>}
                          {v.redirect_url && <Link2 size={10} className="text-amber-600 dark:text-amber-400" />}
                          {v.redirect_url && v.tracking_verified === true && <ShieldCheck size={10} className="text-green-600 dark:text-green-400" />}
                          {v.redirect_url && v.tracking_verified === false && <ShieldX size={10} className="text-red-600 dark:text-red-400" />}
                        </span>
                      ))}
                    </div>
                    {/* Tracking check buttons */}
                    {canManage && (test.test_variants ?? []).some((v) => v.redirect_url) && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {(test.test_variants ?? []).filter((v) => v.redirect_url).map((v) => (
                          <button
                            key={v.id}
                            onClick={(e) => { e.stopPropagation(); checkTracking(v.id, v.redirect_url!); }}
                            disabled={checkingTracking === v.id}
                            className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-200 bg-slate-100 dark:bg-slate-700/50 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-600/50 rounded-full px-2 py-0.5 transition-colors disabled:opacity-50"
                          >
                            {checkingTracking === v.id ? <Spinner size="sm" /> : v.tracking_verified === true ? <ShieldCheck size={9} className="text-green-600 dark:text-green-400" /> : v.tracking_verified === false ? <ShieldX size={9} className="text-red-600 dark:text-red-400" /> : <ShieldCheck size={9} />}
                            Check {v.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Link href={`/clients/${clientId}/tests/${test.id}`} className="btn-secondary text-xs" onClick={e => e.stopPropagation()}>
                      Analytics
                    </Link>
                    {canManage && (
                      <div className="relative">
                        <button onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === test.id ? null : test.id); }} className="btn-secondary p-2" disabled={updatingStatusId === test.id}>
                          {updatingStatusId === test.id ? <Spinner size="sm" /> : <MoreHorizontal size={14} />}
                        </button>
                        {activeMenu === test.id && (
                          <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl z-10 overflow-hidden">
                            {test.status === 'draft' && (
                              <button onClick={(e) => { e.stopPropagation(); updateStatus(test.id, 'active'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                                <Play size={14} className="text-green-600 dark:text-green-400" /> Activate
                              </button>
                            )}
                            {test.status === 'active' && (
                              <button onClick={(e) => { e.stopPropagation(); updateStatus(test.id, 'paused'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                                <Pause size={14} className="text-amber-600 dark:text-amber-400" /> Pause
                              </button>
                            )}
                            {test.status === 'paused' && (
                              <>
                                <button onClick={(e) => { e.stopPropagation(); updateStatus(test.id, 'active'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                                  <Play size={14} className="text-green-600 dark:text-green-400" /> Resume
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); updateStatus(test.id, 'completed'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                                  <Check size={14} className="text-blue-600 dark:text-blue-400" /> Complete
                                </button>
                              </>
                            )}
                            <button onClick={(e) => { e.stopPropagation(); openEditModal(test); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                              <Edit2 size={14} className="text-indigo-600 dark:text-indigo-400" /> Edit
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); openAddVariant(test); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                              <Plus size={14} className="text-indigo-600 dark:text-indigo-400" /> Add Variant
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); openDuplicate(test); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                              <Copy size={14} className="text-indigo-600 dark:text-indigo-400" /> Duplicate
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteId(test.id); setActiveMenu(null); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-700 border-t border-slate-200 dark:border-slate-700">
                              <Trash2 size={14} /> Delete
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Page Modal */}
      <Modal open={createOpen} onClose={() => { setCreateOpen(false); resetCreateForm(); }} title="New Page" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          {/* How do you want to add this page? */}
          <div className="grid grid-cols-3 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden -mt-1">
            <button
              type="button"
              onClick={() => setCreateMode('url')}
              className={`py-2 text-sm font-medium transition-colors ${createMode === 'url' ? 'bg-[#3D8BDA] text-white' : 'bg-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
            >
              Paste a link
            </button>
            <button
              type="button"
              onClick={() => setCreateMode('html')}
              className={`py-2 text-sm font-medium transition-colors border-l border-slate-200 dark:border-slate-700 ${createMode === 'html' ? 'bg-[#3D8BDA] text-white' : 'bg-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
            >
              Paste HTML
            </button>
            <button
              type="button"
              onClick={() => setCreateMode('ai')}
              className={`py-2 text-sm font-medium transition-colors border-l border-slate-200 dark:border-slate-700 ${createMode === 'ai' ? 'bg-[#3D8BDA] text-white' : 'bg-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
            >
              Build with AI
            </button>
          </div>

          {/* Mode explainer — clarifies that the base domain is already set in Domains */}
          <div className="flex items-start gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 px-3 py-2.5 text-xs text-slate-500 dark:text-slate-400">
            <Info size={13} className="flex-shrink-0 mt-px text-slate-400" />
            <span>
              {createMode === 'url' && <>Paste the link to your existing page (Lovable, Webflow, Framer, or any URL). We serve it under your domain and add tracking automatically. You&apos;re not choosing a new URL — your domain is already set in <strong>Domains</strong>; you just pick the path below.</>}
              {createMode === 'html' && <>Paste your page&apos;s full HTML below. We host and serve it under your domain with tracking built in — no <code className="font-mono">tracker.js</code> tag needed.</>}
              {createMode === 'ai' && <>Give the page a name and path, and we&apos;ll open the AI editor so you can build it from scratch. It&apos;s saved as a draft on your domain until you publish it.</>}
            </span>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Page Name</label>
            <input type="text" value={pageName} onChange={(e) => setPageName(e.target.value)} className="input-base" placeholder="Homepage" required autoFocus />
          </div>

          {createMode === 'url' ? (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Link to your existing page</label>
              <input
                type="text"
                value={destinationUrl}
                onChange={(e) => { setDestinationUrl(e.target.value); }}
                className="input-base font-mono text-sm"
                placeholder="https://your-page.lovable.app"
                required
              />
              <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">The Lovable / Webflow / Framer / any URL where your page currently lives.</p>
            </div>
          ) : createMode === 'html' ? (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">HTML Content</label>
              <textarea
                value={createHtml}
                onChange={(e) => setCreateHtml(e.target.value)}
                className="input-base font-mono text-xs resize-none"
                rows={8}
                placeholder={'<!DOCTYPE html>\n<html>\n  <body>\n    <!-- paste your full page HTML here -->\n  </body>\n</html>'}
                required
              />
              <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">Paste your full page HTML. SplitLab will host and serve it directly.</p>
              <div className="mt-2">
                <label className="btn-secondary text-xs inline-flex items-center gap-1.5 cursor-pointer">
                  <FileCode2 size={12} /> Upload .html file
                  <input
                    type="file"
                    accept=".html,.htm"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => setCreateHtml(reader.result as string);
                      reader.readAsText(file);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400 mt-2">
                <Info size={13} className="flex-shrink-0 mt-px" />
                <span>Tracking is already built in for this page — <strong>no need to add a <code className="font-mono">tracker.js</code> script tag.</strong></span>
              </div>
            </div>
          ) : null}

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Path on your domain</label>
            {domain ? (
              // Base domain is fixed — show it as a static prefix and only ask
              // for the path suffix, so it's obvious the URL is inherited.
              <div className="flex items-stretch rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500/40 focus-within:border-indigo-500">
                <span className="flex items-center px-3 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-sm font-mono border-r border-slate-300 dark:border-slate-700 whitespace-nowrap">
                  {domain}
                </span>
                <input
                  type="text"
                  value={urlPath}
                  onChange={(e) => setUrlPath(e.target.value)}
                  className="flex-1 min-w-0 bg-transparent px-3 py-2 text-sm font-mono outline-none text-slate-900 dark:text-slate-100"
                  placeholder="/landing"
                  required
                />
              </div>
            ) : (
              <input type="text" value={urlPath} onChange={(e) => setUrlPath(e.target.value)} className="input-base font-mono" placeholder="/" required />
            )}
            <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">
              {domain
                ? 'The base domain is fixed — just set the path (e.g. / or /landing).'
                : 'Where on your domain this page will be served (e.g. / or /landing).'}
            </p>
          </div>

          {createPageError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5 text-sm text-red-600 dark:text-red-400">
              {createPageError.message}
              {createPageError.isLimit && (
                <> · <a href="/billing" className="underline font-medium hover:text-red-800 dark:hover:text-red-300">Upgrade Plan</a></>
              )}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => { setCreateOpen(false); resetCreateForm(); }}>Cancel</Button>
            <Button type="submit" loading={saving}>{createMode === 'ai' ? 'Create & open AI editor' : 'Create Page'}</Button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal open={!!editTestId} onClose={() => setEditTestId(null)} title="Edit Page" size="sm">
        <form onSubmit={handleEdit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Page Name</label>
            <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="input-base" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">URL Path</label>
            <input type="text" value={editUrlPath} onChange={(e) => setEditUrlPath(e.target.value)} className="input-base font-mono" required />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => setEditTestId(null)}>Cancel</Button>
            <Button type="submit" loading={editSaving}>Save Changes</Button>
          </div>
        </form>
      </Modal>

      {/* Duplicate Page Modal */}
      <Modal open={!!duplicateTest} onClose={() => setDuplicateTest(null)} title="Duplicate Page" size="sm">
        <form onSubmit={handleDuplicate} className="space-y-4">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Copies <span className="font-medium text-slate-700 dark:text-slate-300">{duplicateTest?.name}</span> and all its variants. Give it a new name and path, then tweak the variants.
          </p>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Page Name</label>
            <input type="text" value={dupName} onChange={(e) => setDupName(e.target.value)} className="input-base" required autoFocus />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Path on your domain</label>
            {domain ? (
              <div className="flex items-stretch rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500/40 focus-within:border-indigo-500">
                <span className="flex items-center px-3 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-sm font-mono border-r border-slate-300 dark:border-slate-700 whitespace-nowrap">
                  {domain}
                </span>
                <input
                  type="text"
                  value={dupPath}
                  onChange={(e) => setDupPath(e.target.value)}
                  className="flex-1 min-w-0 bg-transparent px-3 py-2 text-sm font-mono outline-none text-slate-900 dark:text-slate-100"
                  placeholder="/landing-copy"
                  required
                />
              </div>
            ) : (
              <input type="text" value={dupPath} onChange={(e) => setDupPath(e.target.value)} className="input-base font-mono" required />
            )}
            <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">Must differ from the original so both pages can serve.</p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => setDuplicateTest(null)}>Cancel</Button>
            <Button type="submit" loading={duplicating}>Duplicate</Button>
          </div>
        </form>
      </Modal>

      {/* Add Variant Modal */}
      <Modal open={!!addVariantTestId} onClose={() => { setAddVariantTestId(null); setAddVariantError(null); }} title="Add Variant" size="sm">
        <form onSubmit={handleAddVariant} className="space-y-4">
          {/* Mode toggle */}
          <div className="flex border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setVariantMode('url')}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${variantMode === 'url' ? 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50'}`}
            >
              External URL
            </button>
            <button
              type="button"
              onClick={() => setVariantMode('html')}
              className={`flex-1 py-2 text-sm font-medium transition-colors border-l border-slate-200 dark:border-slate-700 ${variantMode === 'html' ? 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50'}`}
            >
              Upload HTML
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Variant Name</label>
            <input type="text" value={variantName} onChange={(e) => setVariantName(e.target.value)} className="input-base" required />
          </div>

          {variantMode === 'url' ? (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Destination URL</label>
              <input
                type="url"
                value={variantUrl}
                onChange={(e) => { setVariantUrl(e.target.value); }}
                className="input-base font-mono text-sm"
                placeholder="https://example.com/variant-b"
                required
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">HTML Content</label>
              <textarea
                value={variantHtml}
                onChange={(e) => setVariantHtml(e.target.value)}
                className="input-base font-mono text-xs w-full h-40 resize-y"
                placeholder="<!DOCTYPE html>\n<html>\n<head>...</head>\n<body>...</body>\n</html>"
                required
              />
              <div className="mt-2">
                <label className="btn-secondary text-xs inline-flex items-center gap-1.5 cursor-pointer">
                  <FileCode2 size={12} /> Upload .html file
                  <input
                    type="file"
                    accept=".html,.htm"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => setVariantHtml(reader.result as string);
                      reader.readAsText(file);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400 mt-2">
                <Info size={13} className="flex-shrink-0 mt-px" />
                <span>Tracking is already built in for this page — <strong>no need to add a <code className="font-mono">tracker.js</code> script tag.</strong></span>
              </div>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg bg-slate-500/10 border border-slate-500/20 px-3 py-2.5 text-xs text-slate-600 dark:text-slate-400">
            <Info size={13} className="flex-shrink-0 mt-px" />
            <span>
              This variant starts at <strong>0% traffic</strong>. The test&apos;s current
              split stays exactly as it is — set its weight on the test page
              when you want to send traffic to it.
            </span>
          </div>

          {addVariantError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5 text-sm text-red-600 dark:text-red-400">
              {addVariantError.message}
              {addVariantError.isLimit && (
                <> · <a href="/billing" className="underline font-medium hover:text-red-800 dark:hover:text-red-300">Upgrade Plan</a></>
              )}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => { setAddVariantTestId(null); setAddVariantError(null); }}>Cancel</Button>
            <Button type="submit" loading={addingVariant}>Add Variant</Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete Page"
        description="This will permanently delete the page and all its event data. This cannot be undone."
        loading={deleting}
      />
    </>
  );
}
