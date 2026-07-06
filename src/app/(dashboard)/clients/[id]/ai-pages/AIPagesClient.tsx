'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Sparkles, ExternalLink, Edit2, Globe, Trash2, Loader2, Lock, ArrowRight, Sliders, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';
import { VERTICALS, VERTICAL_LABELS, VERTICAL_COLORS } from '@/lib/ai-page-verticals';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';

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
    <Modal open onClose={onClose} title="AI Page Builder requires an upgrade" size="sm">
      <div className="w-12 h-12 rounded-xl bg-indigo-500/15 border border-indigo-500/25 flex items-center justify-center mb-5">
        <Lock size={22} className="text-indigo-500 dark:text-indigo-400" />
      </div>
      <p className="text-slate-500 dark:text-slate-400 text-sm leading-relaxed mb-1">
        This feature is only available on the{' '}
        <strong className="text-slate-900 dark:text-white">Agency</strong> and{' '}
        <strong className="text-slate-900 dark:text-white">Scale</strong> plans.
      </p>
      <p className="text-slate-400 dark:text-slate-500 text-sm leading-relaxed mb-6">
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
        className="w-full mt-3 py-2 text-sm text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
      >
        Maybe later
      </button>
    </Modal>
  );
}

const PAGE_SIZE = 10;

export default function AIPagesClient({ pages: initialPages, clientId, workspaceId, canManage, canUseAI }: Props) {
  const router = useRouter();
  const [pages, setPages] = useState(initialPages);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newVertical, setNewVertical] = useState('lead_gen');
  const [creating, setCreating] = useState(false);

  const pageToDelete = pages.find((p) => p.id === deleteId);

  const totalPages = Math.max(1, Math.ceil(pages.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedPages = pages.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const rangeStart = pages.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(safePage * PAGE_SIZE, pages.length);

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
          <p className="text-sm text-slate-500 dark:text-slate-400">{pages.length} AI-generated page{pages.length !== 1 ? 's' : ''}</p>
        </div>
        {canManage && (
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" />
            Create New
          </Button>
        )}
      </div>

      {pages.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No AI pages yet"
          description="Generate your first landing page with AI"
          action={canManage ? (
            <Button onClick={openCreate}>
              <Plus className="w-4 h-4" />
              Create New
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-white/[0.02]">
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Name</th>
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Vertical</th>
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Status</th>
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Hosted URL</th>
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Created</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {pagedPages.map((page) => (
                <tr key={page.id} className="hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors">
                  <td className="px-5 py-3.5 font-medium text-slate-900 dark:text-white">{page.name}</td>
                  <td className="px-5 py-3.5">
                    {page.vertical ? (
                      <span className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border',
                        VERTICAL_COLORS[page.vertical] ?? 'bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20'
                      )}>
                        {VERTICAL_LABELS[page.vertical] ?? page.vertical}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={cn(
                      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border',
                      page.is_published
                        ? 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20'
                        : 'bg-amber-500/10 text-amber-600 dark:text-yellow-400 border-amber-500/20'
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
                        className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 transition-colors truncate max-w-[220px]"
                      >
                        <span className="truncate">{page.published_url}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400">
                    {new Date(page.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openEditor(page.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors"
                      >
                        <Edit2 className="w-3 h-3" />
                        Edit in Builder
                      </button>
                      <a
                        href={`/clients/${clientId}/ai-pages/${page.id}/utm`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors"
                      >
                        <Sliders className="w-3 h-3" />
                        Set Up UTM
                      </a>
                      {canManage && (
                        <button
                          onClick={() => setDeleteId(page.id)}
                          className="p-1.5 rounded-md text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/20 transition-colors"
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

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-700">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Showing {rangeStart}–{rangeEnd} of {pages.length}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-white/5"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Prev
                </button>
                <div className="flex items-center gap-1 mx-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      onClick={() => setCurrentPage(n)}
                      className={cn(
                        'min-w-[1.75rem] h-7 px-1.5 rounded-md text-xs font-medium transition-colors',
                        n === safePage
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5'
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-white/5"
                >
                  Next
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Upgrade modal — shown when canUseAI=false and user tries to create or edit */}
      {upgradeOpen && <UpgradeModal onClose={() => setUpgradeOpen(false)} />}

      {/* Create modal — only reachable when canUseAI=true */}
      <Modal open={createOpen} onClose={() => !creating && setCreateOpen(false)} title="Create Page with AI" size="sm">
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Page name</label>
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="e.g. Summer Campaign"
              autoFocus
              className="input-base"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Vertical</label>
            <select
              value={newVertical}
              onChange={e => setNewVertical(e.target.value)}
              className="input-base"
            >
              {VERTICALS.map(v => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={creating || !newName.trim()} loading={creating}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </Modal>

      {/* Delete modal */}
      <Modal open={!!deleteId} onClose={() => setDeleteId(null)} title="Delete page?" size="sm">
        <p className="text-slate-500 dark:text-slate-400 text-sm mb-1">
          <span className="text-slate-900 dark:text-white font-medium">{pageToDelete?.name}</span> will be permanently removed from the dashboard.
        </p>
        {pageToDelete?.is_published && (
          <p className="text-amber-600 dark:text-yellow-400 text-xs mb-4">This page is currently published. Its public URL will return 404 after deletion.</p>
        )}
        {!pageToDelete?.is_published && <div className="mb-4" />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleteId(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirmDelete} loading={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
