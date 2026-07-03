'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Sparkles, ExternalLink, Edit2, Globe, Trash2, Loader2, Lock, ArrowRight, Sliders } from 'lucide-react';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';
import { VERTICALS, VERTICAL_LABELS, VERTICAL_COLORS } from '@/lib/ai-page-verticals';

interface AIPage {
  id: string;
  name: string;
  vertical: string | null;
  is_published: boolean;
  published_url: string | null;
  created_at: string;
  users: { name: string }[] | null;
}

interface Props {
  pages: AIPage[];
  clientId: string;
  workspaceId: string;
  canManage: boolean;
  canUseAI: boolean;
}

function UpgradeModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-slate-900 border border-white/10 rounded-2xl p-7 w-full max-w-sm shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="w-12 h-12 rounded-xl bg-indigo-500/15 border border-indigo-500/25 flex items-center justify-center mb-5">
          <Lock size={22} className="text-indigo-400" />
        </div>
        <h3 className="text-white font-semibold text-base mb-2">
          AI Page Builder requires an upgrade
        </h3>
        <p className="text-gray-400 text-sm leading-relaxed mb-1">
          This feature is only available on the{' '}
          <strong className="text-white">Agency</strong> and{' '}
          <strong className="text-white">Scale</strong> plans.
        </p>
        <p className="text-gray-500 text-sm leading-relaxed mb-6">
          Upgrade to generate landing pages with AI, edit them through chat, and publish them as A/B test variants in seconds.
        </p>
        <a
          href="/billing"
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors shadow-lg shadow-indigo-600/20"
        >
          Upgrade Plan
          <ArrowRight size={15} />
        </a>
        <button
          onClick={onClose}
          className="w-full mt-3 py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}

export default function AIPagesClient({ pages: initialPages, clientId, workspaceId, canManage, canUseAI }: Props) {
  const router = useRouter();
  const [pages, setPages] = useState(initialPages);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newVertical, setNewVertical] = useState('lead_gen');
  const [creating, setCreating] = useState(false);

  const pageToDelete = pages.find((p) => p.id === deleteId);

  function openCreate() {
    if (!canUseAI) { setUpgradeOpen(true); return; }
    setNewName('');
    setNewVertical('lead_gen');
    setCreateOpen(true);
  }

  function openEditor(pageId: string) {
    if (!canUseAI) { setUpgradeOpen(true); return; }
    router.push(`/clients/${clientId}/ai-pages/new?page_id=${pageId}`);
  }

  async function handleCreate() {
    if (!newName.trim() || !canUseAI) return;
    setCreating(true);
    try {
      const res = await fetch('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, name: newName.trim(), vertical: newVertical }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to create page'); }
      const page = await res.json();
      router.push(`/clients/${clientId}/ai-pages/new?page_id=${page.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create page');
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/pages/${deleteId}/delete`, { method: 'POST' });
      if (!res.ok) throw new Error();
      setPages((prev) => prev.filter((p) => p.id !== deleteId));
      setDeleteId(null);
    } catch {
      toast.error('Failed to delete page. Please try again.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-400">{pages.length} AI-generated page{pages.length !== 1 ? 's' : ''}</p>
        </div>
        {canManage && (
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create New
          </button>
        )}
      </div>

      {pages.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto mb-4">
            <Sparkles className="w-6 h-6 text-indigo-400" />
          </div>
          <p className="text-white font-medium mb-1">No AI pages yet</p>
          <p className="text-gray-400 text-sm mb-5">Generate your first landing page with AI</p>
          {canManage && (
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create New
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/[0.02]">
                <th className="text-left px-5 py-3 text-gray-400 font-medium">Name</th>
                <th className="text-left px-5 py-3 text-gray-400 font-medium">Vertical</th>
                <th className="text-left px-5 py-3 text-gray-400 font-medium">Status</th>
                <th className="text-left px-5 py-3 text-gray-400 font-medium">Hosted URL</th>
                <th className="text-left px-5 py-3 text-gray-400 font-medium">Created</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {pages.map((page) => (
                <tr key={page.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="px-5 py-3.5 font-medium text-white">{page.name}</td>
                  <td className="px-5 py-3.5">
                    {page.vertical ? (
                      <span className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border',
                        VERTICAL_COLORS[page.vertical] ?? 'bg-gray-500/10 text-gray-400 border-gray-500/20'
                      )}>
                        {VERTICAL_LABELS[page.vertical] ?? page.vertical}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={cn(
                      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border',
                      page.is_published
                        ? 'bg-green-500/10 text-green-400 border-green-500/20'
                        : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                    )}>
                      <Globe className="w-3 h-3" />
                      {page.is_published ? 'Published' : 'Draft'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    {page.published_url ? (
                      <a
                        href={page.published_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors truncate max-w-[220px]"
                      >
                        <span className="truncate">{page.published_url}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-gray-400">
                    {new Date(page.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openEditor(page.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
                      >
                        <Edit2 className="w-3 h-3" />
                        Edit in Builder
                      </button>
                      <a
                        href={`/clients/${clientId}/ai-pages/${page.id}/utm`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
                      >
                        <Sliders className="w-3 h-3" />
                        Set Up UTM
                      </a>
                      {canManage && (
                        <button
                          onClick={() => setDeleteId(page.id)}
                          className="p-1.5 rounded-md text-red-400 hover:bg-red-500/20 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Upgrade modal — shown when canUseAI=false and user tries to create or edit */}
      {upgradeOpen && <UpgradeModal onClose={() => setUpgradeOpen(false)} />}

      {/* Create modal — only reachable when canUseAI=true */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !creating && setCreateOpen(false)}>
          <div className="bg-slate-900 border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-white font-semibold text-base mb-4">Create Page with AI</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Page name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                  placeholder="e.g. Summer Campaign"
                  autoFocus
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Vertical</label>
                <select
                  value={newVertical}
                  onChange={e => setNewVertical(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                >
                  {VERTICALS.map(v => (
                    <option key={v.value} value={v.value} className="bg-slate-900">{v.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setCreateOpen(false)}
                disabled={creating}
                className="px-4 py-2 rounded-lg text-sm text-gray-300 bg-white/5 hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="px-4 py-2 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete modal */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-900 border border-white/10 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-white font-semibold text-base mb-1">Delete page?</h2>
            <p className="text-gray-400 text-sm mb-1">
              <span className="text-white font-medium">{pageToDelete?.name}</span> will be permanently removed from the dashboard.
            </p>
            {pageToDelete?.is_published && (
              <p className="text-yellow-400 text-xs mb-4">This page is currently published. Its public URL will return 404 after deletion.</p>
            )}
            {!pageToDelete?.is_published && <div className="mb-4" />}
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteId(null)} disabled={deleting} className="px-4 py-2 rounded-lg text-sm text-gray-300 bg-white/5 hover:bg-white/10 transition-colors">
                Cancel
              </button>
              <button onClick={confirmDelete} disabled={deleting} className="px-4 py-2 rounded-lg text-sm text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-colors">
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
