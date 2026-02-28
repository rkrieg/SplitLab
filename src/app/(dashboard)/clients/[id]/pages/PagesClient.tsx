'use client';

import { useState, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  Plus, FileCode2, Upload, Code2, Eye, Edit2, Copy, Trash2,
  Tag, X, Check, Link,
} from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { formatDate } from '@/lib/utils';

// CodeMirror loaded client-side only
const CodeEditor = dynamic(() => import('@/components/pages/CodeEditor'), { ssr: false });

interface Page {
  id: string;
  name: string;
  slug: string | null;
  html_url: string;
  html_content: string | null;
  tags: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

interface Props {
  initialPages: Page[];
  workspaceId: string;
  canManage: boolean;
}

type UploadTab = 'file' | 'code' | 'url';

export default function PagesClient({ initialPages, workspaceId, canManage }: Props) {
  const router = useRouter();
  const [pages, setPages] = useState(initialPages);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editPage, setEditPage] = useState<Page | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [previewPage, setPreviewPage] = useState<Page | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<UploadTab>('file');
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);

  // Form
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [htmlContent, setHtmlContent] = useState('<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>Landing Page</title>\n</head>\n<body>\n  \n</body>\n</html>');
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('workspace_id', workspaceId);
      if (tags) formData.append('tags', tags);

      if (tab === 'file') {
        const file = fileRef.current?.files?.[0];
        if (!file) { toast.error('Please select an HTML file'); return; }
        formData.append('file', file);
      } else {
        formData.append('html', htmlContent);
      }

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Upload failed');
        return;
      }

      const page = await res.json();
      setPages((prev) => [page, ...prev]);
      setUploadOpen(false);
      resetForm();
      toast.success('Page uploaded');
      router.refresh();
    } catch {
      toast.error('Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editPage) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/pages/${editPage.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editPage.name, html_content: editPage.html_content }),
      });
      if (!res.ok) { toast.error('Save failed'); return; }
      const updated = await res.json();
      setPages((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setEditPage(null);
      toast.success('Page saved');
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate(page: Page) {
    const formData = new FormData();
    formData.append('name', `${page.name} (copy)`);
    formData.append('workspace_id', workspaceId);
    formData.append('html', page.html_content || '');

    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) { toast.error('Duplicate failed'); return; }
    const copy = await res.json();
    setPages((prev) => [copy, ...prev]);
    toast.success('Page duplicated');
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/pages/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) { toast.error('Delete failed'); return; }
      setPages((prev) => prev.filter((p) => p.id !== deleteId));
      toast.success('Page deleted');
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  }

  function resetForm() {
    setName('');
    setTags('');
    setHtmlContent('<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>Landing Page</title>\n</head>\n<body>\n  \n</body>\n</html>');
    setTab('file');
    setImportUrl('');
    if (fileRef.current) fileRef.current.value = '';
  }

  async function handleImportUrl() {
    if (!importUrl.trim()) return;
    setImporting(true);
    try {
      const res = await fetch('/api/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: importUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to fetch URL');
        return;
      }
      setHtmlContent(data.html);
      setTab('code');
      toast.success('HTML imported — review and save below');
    } catch {
      toast.error('Failed to fetch URL');
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <p className="text-slate-400 text-sm">{pages.length} page{pages.length !== 1 ? 's' : ''}</p>
        {canManage && (
          <Button onClick={() => setUploadOpen(true)}>
            <Plus size={16} /> Upload Page
          </Button>
        )}
      </div>

      {pages.length === 0 && (
        <EmptyState
          icon={FileCode2}
          title="No pages yet"
          description="Upload HTML files or write them directly in the code editor."
          action={canManage ? <Button onClick={() => setUploadOpen(true)}><Plus size={16} /> Upload Page</Button> : undefined}
        />
      )}

      {pages.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {pages.map((page) => (
            <div key={page.id} className="card p-5 flex flex-col">
              <div className="flex items-start justify-between mb-3">
                <div className="w-9 h-9 rounded-lg bg-slate-700 flex items-center justify-center flex-shrink-0">
                  <FileCode2 size={16} className="text-indigo-400" />
                </div>
                {page.status === 'archived' && (
                  <span className="badge bg-slate-600 text-slate-400 text-[10px]">archived</span>
                )}
              </div>
              <h3 className="font-semibold text-slate-100 mb-1 truncate">{page.name}</h3>
              <p className="text-slate-500 text-xs mb-3">{formatDate(page.created_at)}</p>

              {page.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {page.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="flex items-center gap-1 badge bg-slate-700 text-slate-400 text-[10px]">
                      <Tag size={9} />
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2 mt-auto pt-3 border-t border-slate-700/50">
                <button
                  onClick={() => setPreviewPage(page)}
                  className="flex-1 btn-secondary text-xs justify-center py-1.5"
                >
                  <Eye size={13} /> Preview
                </button>
                {canManage && (
                  <>
                    <button
                      onClick={() => setEditPage({ ...page })}
                      className="btn-secondary p-1.5"
                      title="Edit"
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      onClick={() => handleDuplicate(page)}
                      className="btn-secondary p-1.5"
                      title="Duplicate"
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      onClick={() => setDeleteId(page.id)}
                      className="btn-secondary p-1.5 hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload modal */}
      <Modal open={uploadOpen} onClose={() => { setUploadOpen(false); resetForm(); }} title="Upload Page" size="xl">
        <form onSubmit={handleUpload} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Page Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-base" placeholder="Homepage Hero" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Tags (comma-separated)</label>
              <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} className="input-base" placeholder="hero, cta, v2" />
            </div>
          </div>

          {/* Tab selector */}
          <div className="flex gap-1 bg-slate-700/50 p-1 rounded-lg w-fit">
            <button type="button" onClick={() => setTab('file')} className={`px-3 py-1.5 text-sm rounded-md transition-colors ${tab === 'file' ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-300'}`}>
              <span className="flex items-center gap-1.5"><Upload size={13} /> Upload File</span>
            </button>
            <button type="button" onClick={() => setTab('code')} className={`px-3 py-1.5 text-sm rounded-md transition-colors ${tab === 'code' ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-300'}`}>
              <span className="flex items-center gap-1.5"><Code2 size={13} /> Paste HTML</span>
            </button>
            <button type="button" onClick={() => setTab('url')} className={`px-3 py-1.5 text-sm rounded-md transition-colors ${tab === 'url' ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-300'}`}>
              <span className="flex items-center gap-1.5"><Link size={13} /> Import from URL</span>
            </button>
          </div>

          {tab === 'file' && (
            <div className="border-2 border-dashed border-slate-600 rounded-xl p-8 text-center">
              <Upload size={24} className="mx-auto text-slate-500 mb-2" />
              <p className="text-slate-400 text-sm mb-3">Drop an HTML file or click to browse</p>
              <input ref={fileRef} type="file" accept=".html,.htm" className="hidden" id="html-file" />
              <label htmlFor="html-file" className="btn-secondary cursor-pointer">Browse Files</label>
            </div>
          )}

          {tab === 'url' && (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-300">Page URL</label>
              <p className="text-slate-500 text-xs -mt-1">Paste any URL — Loveable, Replit preview, or any public webpage. The HTML will be fetched and loaded into the editor.</p>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  className="input-base flex-1"
                  placeholder="https://my-app.lovable.app"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleImportUrl(); } }}
                />
                <Button
                  type="button"
                  onClick={handleImportUrl}
                  loading={importing}
                  disabled={!importUrl.trim()}
                >
                  <Link size={14} /> Fetch
                </Button>
              </div>
            </div>
          )}

          {tab === 'code' && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">HTML Content</label>
              <CodeEditor value={htmlContent} onChange={setHtmlContent} height="350px" />
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => { setUploadOpen(false); resetForm(); }}>Cancel</Button>
            <Button type="submit" loading={uploading}>Upload Page</Button>
          </div>
        </form>
      </Modal>

      {/* Edit modal */}
      {editPage && (
        <Modal open={!!editPage} onClose={() => setEditPage(null)} title="Edit Page" size="xl">
          <form onSubmit={handleSaveEdit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Page Name</label>
              <input type="text" value={editPage.name} onChange={(e) => setEditPage({ ...editPage, name: e.target.value })} className="input-base" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">HTML Content</label>
              <CodeEditor value={editPage.html_content || ''} onChange={(v) => setEditPage({ ...editPage, html_content: v })} height="400px" />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="secondary" type="button" onClick={() => setEditPage(null)}>Cancel</Button>
              <Button type="submit" loading={saving}><Check size={14} /> Save Changes</Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Preview modal */}
      {previewPage && (
        <Modal open={!!previewPage} onClose={() => setPreviewPage(null)} title={`Preview: ${previewPage.name}`} size="xl">
          <div className="border border-slate-700 rounded-lg overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-slate-700/50 border-b border-slate-700">
              <div className="flex gap-1">
                <div className="w-3 h-3 rounded-full bg-red-500/60" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                <div className="w-3 h-3 rounded-full bg-green-500/60" />
              </div>
              <span className="text-slate-500 text-xs ml-2">Preview</span>
            </div>
            <iframe
              srcDoc={previewPage.html_content || undefined}
              src={!previewPage.html_content ? previewPage.html_url : undefined}
              sandbox="allow-same-origin allow-scripts"
              className="w-full bg-white"
              style={{ height: '500px' }}
            />
          </div>
          <div className="flex justify-end mt-4">
            <Button variant="secondary" onClick={() => setPreviewPage(null)}><X size={14} /> Close</Button>
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete Page"
        description="This will permanently delete the page. Any tests using this page will lose the reference."
        loading={deleting}
      />
    </>
  );
}
