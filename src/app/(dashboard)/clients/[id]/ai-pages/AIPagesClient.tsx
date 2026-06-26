'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Sparkles, ExternalLink, Edit2, Globe, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  canManage: boolean;
}

const VERTICAL_LABELS: Record<string, string> = {
  lead_gen: 'Lead Gen',
  saas: 'SaaS',
  local: 'Local',
};

const VERTICAL_COLORS: Record<string, string> = {
  lead_gen: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  saas:     'bg-blue-500/10 text-blue-400 border-blue-500/20',
  local:    'bg-green-500/10 text-green-400 border-green-500/20',
};

export default function AIPagesClient({ pages: initialPages, clientId, canManage }: Props) {
  const router = useRouter();
  const [pages, setPages] = useState(initialPages);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const pageToDelete = pages.find((p) => p.id === deleteId);

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/pages/${deleteId}/delete`, { method: 'POST' });
      if (!res.ok) throw new Error();
      setPages((prev) => prev.filter((p) => p.id !== deleteId));
      setDeleteId(null);
    } catch {
      alert('Failed to delete page. Please try again.');
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
          <Link
            href={`/clients/${clientId}/pages/ai/create`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create New
          </Link>
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
            <Link
              href={`/clients/${clientId}/pages/ai/create`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create New
            </Link>
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
                        onClick={() => router.push(`/clients/${clientId}/ai-pages/new?page_id=${page.id}`)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
                      >
                        <Edit2 className="w-3 h-3" />
                        Edit in Builder
                      </button>
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
              <button
                onClick={() => setDeleteId(null)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm text-gray-300 bg-white/5 hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-colors"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
