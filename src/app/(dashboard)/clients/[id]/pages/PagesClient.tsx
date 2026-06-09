'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  Plus, FileCode2, MoreHorizontal, Play, Pause, Check, Trash2,
  Globe, Link2, ShieldCheck, ShieldX, Edit2, Sparkles, AlertTriangle,
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
  const [createMode, setCreateMode] = useState<'url' | 'html'>('url');
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
  const [variantUrlFrameable, setVariantUrlFrameable] = useState<boolean | null>(null);
  const [variantWeight, setVariantWeight] = useState(50);
  const [addingVariant, setAddingVariant] = useState(false);
  const [variantMode, setVariantMode] = useState<'url' | 'html'>('url');
  const [variantHtml, setVariantHtml] = useState('');

  // Modal errors
  const [createPageError, setCreatePageError] = useState<{ message: string; isLimit: boolean } | null>(null);
  const [addVariantError, setAddVariantError] = useState<{ message: string; isLimit: boolean } | null>(null);

  async function checkFrameable(url: string, setter: (v: boolean | null) => void) {
    if (!url.startsWith('http')) { setter(null); return; }
    try {
      const res = await fetch(`/api/check-frameable?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      setter(data.frameable ?? null);
    } catch {
      setter(null);
    }
  }

  // ─── Create Page ────────────────────────────────────────────────────────

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
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
        res = await fetch(`/api/workspaces/${workspaceId}/tests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: pageName,
            url_path: urlPath,
            variants: [{
              name: 'Control',
              redirect_url: normalizedUrl,
              proxy_mode: true,
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
      const newTest = await res.json();
      setTests((prev) => [newTest, ...prev]);
      setCreateOpen(false);
      resetCreateForm();
      toast.success('Page created');
      router.refresh();
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
      if (!res.ok) { toast.error('Failed to update status'); return; }
      setTests((prev) => prev.map((t) => (t.id === testId ? { ...t, status } : t)));
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
      toast.success('Page deleted');
    } finally { setDeleting(false); setDeleteId(null); }
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
    setVariantUrlFrameable(null);
    setVariantWeight(50);
    setVariantMode('url');
    setVariantHtml('');
    setActiveMenu(null);
  }

  async function handleAddVariant(e: React.FormEvent) {
    e.preventDefault();
    if (!addVariantTestId) return;
    setAddingVariant(true);
    try {
      const payload = variantMode === 'html'
        ? { name: variantName, html_content: variantHtml, traffic_weight: variantWeight }
        : { name: variantName, redirect_url: variantUrl, proxy_mode: true, traffic_weight: variantWeight };
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
      setAddVariantTestId(null);
      setAddVariantError(null);
      setVariantUrlFrameable(null);
      toast.success('Variant added');
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
            {/* <Link
              href={`/clients/${clientId}/tests/new/ai`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] transition-colors"
            >
              <Sparkles size={16} /> Generate with AI
            </Link> */}
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
                          <Globe size={12} className="text-green-400" />
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
                          {v.is_control && <span className="text-indigo-400 text-[10px]">ctrl</span>}
                          {v.redirect_url && <Link2 size={10} className="text-amber-400" />}
                          {v.redirect_url && v.tracking_verified === true && <ShieldCheck size={10} className="text-green-400" />}
                          {v.redirect_url && v.tracking_verified === false && <ShieldX size={10} className="text-red-400" />}
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
                            {checkingTracking === v.id ? <Spinner size="sm" /> : v.tracking_verified === true ? <ShieldCheck size={9} className="text-green-400" /> : v.tracking_verified === false ? <ShieldX size={9} className="text-red-400" /> : <ShieldCheck size={9} />}
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
                                <Play size={14} className="text-green-400" /> Activate
                              </button>
                            )}
                            {test.status === 'active' && (
                              <button onClick={(e) => { e.stopPropagation(); updateStatus(test.id, 'paused'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                                <Pause size={14} className="text-amber-400" /> Pause
                              </button>
                            )}
                            {test.status === 'paused' && (
                              <>
                                <button onClick={(e) => { e.stopPropagation(); updateStatus(test.id, 'active'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                                  <Play size={14} className="text-green-400" /> Resume
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); updateStatus(test.id, 'completed'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                                  <Check size={14} className="text-blue-400" /> Complete
                                </button>
                              </>
                            )}
                            <button onClick={(e) => { e.stopPropagation(); openEditModal(test); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                              <Edit2 size={14} className="text-indigo-400" /> Edit
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); openAddVariant(test); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                              <Plus size={14} className="text-indigo-400" /> Add Variant
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteId(test.id); setActiveMenu(null); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-slate-100 dark:hover:bg-slate-700 border-t border-slate-200 dark:border-slate-700">
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
          {/* URL / HTML tabs */}
          <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden -mt-1">
            <button
              type="button"
              onClick={() => setCreateMode('url')}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${createMode === 'url' ? 'bg-[#3D8BDA] text-white' : 'bg-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
            >
              Paste a URL
            </button>
            <button
              type="button"
              onClick={() => setCreateMode('html')}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${createMode === 'html' ? 'bg-[#3D8BDA] text-white' : 'bg-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
            >
              Paste HTML
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Page Name</label>
            <input type="text" value={pageName} onChange={(e) => setPageName(e.target.value)} className="input-base" placeholder="Homepage" required autoFocus />
          </div>

          {createMode === 'url' ? (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Your Page URL</label>
              <input type="text" value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} className="input-base font-mono text-sm" placeholder="https://yoursite.com/landing" required />
              <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">SplitLab will proxy this page through your domain so A/B tests run on your URL.</p>
            </div>
          ) : (
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
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Path on your domain</label>
            <input type="text" value={urlPath} onChange={(e) => setUrlPath(e.target.value)} className="input-base font-mono" placeholder="/" required />
            <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">
              {domain && urlPath
                ? <span className="font-mono">{domain}{urlPath}</span>
                : 'Where on your domain this page will be served (e.g. / or /landing).'}
            </p>
          </div>

          {createPageError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5 text-sm text-red-400">
              {createPageError.message}
              {createPageError.isLimit && (
                <> · <a href="/billing" className="underline font-medium hover:text-red-300">Upgrade Plan</a></>
              )}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => { setCreateOpen(false); resetCreateForm(); }}>Cancel</Button>
            <Button type="submit" loading={saving}>Create Page</Button>
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

      {/* Add Variant Modal */}
      <Modal open={!!addVariantTestId} onClose={() => { setAddVariantTestId(null); setAddVariantError(null); }} title="Add Variant" size="sm">
        <form onSubmit={handleAddVariant} className="space-y-4">
          {/* Mode toggle */}
          <div className="flex border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setVariantMode('url')}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${variantMode === 'url' ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50'}`}
            >
              External URL
            </button>
            <button
              type="button"
              onClick={() => setVariantMode('html')}
              className={`flex-1 py-2 text-sm font-medium transition-colors border-l border-slate-200 dark:border-slate-700 ${variantMode === 'html' ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50'}`}
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
                onChange={(e) => { setVariantUrl(e.target.value); setVariantUrlFrameable(null); }}
                onBlur={(e) => { const u = e.target.value.trim(); if (u) checkFrameable(u, setVariantUrlFrameable); }}
                className="input-base font-mono text-sm"
                placeholder="https://example.com/variant-b"
                required
              />
              {variantUrlFrameable === false && (
                <p className="mt-1.5 text-xs text-amber-500 flex items-start gap-1.5">
                  <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                  This page blocks iframe embedding. Make sure you own this domain and can add a{' '}
                  <code className="font-mono">&lt;script&gt;</code> tag to it — the preview won&apos;t load inline, but the redirect variant will still work for A/B testing.
                </p>
              )}
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
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Traffic Weight (%)</label>
            <input type="number" value={variantWeight} onChange={(e) => setVariantWeight(Number(e.target.value))} className="input-base w-24" min={1} max={100} required />
          </div>

          {addVariantError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5 text-sm text-red-400">
              {addVariantError.message}
              {addVariantError.isLimit && (
                <> · <a href="/billing" className="underline font-medium hover:text-red-300">Upgrade Plan</a></>
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
