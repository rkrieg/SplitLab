'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Code2, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { formatDate } from '@/lib/utils';

interface Script {
  id: string;
  name: string;
  type: string;
  content: string;
  placement: string;
  is_active: boolean;
  page_id: string | null;
  created_at: string;
  pages?: { id: string; name: string } | null;
}

interface Page { id: string; name: string }

interface Props {
  initialScripts: Script[];
  pages: Page[];
  workspaceId: string;
  canManage: boolean;
}

const SCRIPT_TYPES = [
  { value: 'gtm', label: 'Google Tag Manager', placeholder: 'GTM-XXXXXXX' },
  { value: 'meta_pixel', label: 'Meta Pixel', placeholder: '1234567890' },
  { value: 'ga4', label: 'GA4', placeholder: 'G-XXXXXXXXXX' },
  { value: 'custom', label: 'Custom Script', placeholder: '<script>...</script>' },
];

export default function ScriptsClient({ initialScripts, pages, workspaceId, canManage }: Props) {
  const [scripts, setScripts] = useState(initialScripts);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);

  const [sType, setSType] = useState('gtm');
  const [sName, setSName] = useState('');
  const [sContent, setSContent] = useState('');
  const [sPlacement, setSPlacement] = useState<'head' | 'body_end'>('head');
  const [sPageId, setSPageId] = useState('');

  const selectedType = SCRIPT_TYPES.find((t) => t.value === sType)!;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/scripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sName,
          type: sType,
          content: sContent,
          placement: sPlacement,
          page_id: sPageId || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to add script');
        return;
      }
      const script = await res.json();
      setScripts((prev) => [script, ...prev]);
      setModalOpen(false);
      resetForm();
      toast.success('Script added');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(id: string, is_active: boolean) {
    const res = await fetch(`/api/workspaces/${workspaceId}/scripts`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, is_active: !is_active }),
    });
    if (!res.ok) { toast.error('Failed to update script'); return; }
    setScripts((prev) =>
      prev.map((s) => (s.id === id ? { ...s, is_active: !is_active } : s))
    );
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/scripts`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteId }),
      });
      if (!res.ok) { toast.error('Delete failed'); return; }
      setScripts((prev) => prev.filter((s) => s.id !== deleteId));
      toast.success('Script deleted');
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  }

  function resetForm() {
    setSType('gtm'); setSName(''); setSContent(''); setSPlacement('head'); setSPageId('');
  }

  const typeLabel: Record<string, string> = {
    gtm: 'GTM',
    meta_pixel: 'Meta Pixel',
    ga4: 'GA4',
    custom: 'Custom',
  };

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <p className="text-slate-400 text-sm">{scripts.length} script{scripts.length !== 1 ? 's' : ''}</p>
        {canManage && <Button onClick={() => setModalOpen(true)}><Plus size={16} /> Add Script</Button>}
      </div>

      {/* Info banner */}
      <div className="card p-4 mb-6 border-slate-600 bg-slate-800/50 text-sm text-slate-400">
        Scripts marked as <strong className="text-slate-300">workspace-level</strong> will be injected into every page served for this client.
        You can also assign a script to a specific page only.
      </div>

      {scripts.length === 0 && (
        <EmptyState
          icon={Code2}
          title="No scripts yet"
          description="Add GTM, Meta Pixel, GA4, or any custom script to inject into your pages."
          action={canManage ? <Button onClick={() => setModalOpen(true)}><Plus size={16} /> Add Script</Button> : undefined}
        />
      )}

      {scripts.length > 0 && (
        <div className="space-y-3">
          {scripts.map((script) => (
            <div key={script.id} className={`card p-5 flex items-center gap-4 ${!script.is_active ? 'opacity-50' : ''}`}>
              <div className="w-9 h-9 rounded-lg bg-slate-700 flex items-center justify-center flex-shrink-0">
                <Code2 size={15} className="text-indigo-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium text-slate-200">{script.name}</span>
                  <span className="badge bg-slate-700 text-slate-400 text-[10px]">{typeLabel[script.type] || script.type}</span>
                  <span className="badge bg-slate-700 text-slate-400 text-[10px]">{script.placement === 'head' ? '<head>' : '</body>'}</span>
                  {script.pages && (
                    <span className="badge bg-blue-500/20 text-blue-400 border-blue-500/30 text-[10px]">{script.pages.name}</span>
                  )}
                </div>
                <p className="text-slate-500 text-xs font-mono truncate">{script.content.slice(0, 60)}{script.content.length > 60 ? '…' : ''}</p>
                <p className="text-slate-600 text-xs mt-0.5">{formatDate(script.created_at)}</p>
              </div>
              {canManage && (
                <div className="flex items-center gap-2">
                  <button onClick={() => handleToggle(script.id, script.is_active)} className="text-slate-400 hover:text-slate-200 transition-colors">
                    {script.is_active
                      ? <ToggleRight size={22} className="text-green-400" />
                      : <ToggleLeft size={22} />}
                  </button>
                  <button onClick={() => setDeleteId(script.id)} className="text-slate-500 hover:text-red-400 transition-colors">
                    <Trash2 size={15} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add script modal */}
      <Modal open={modalOpen} onClose={() => { setModalOpen(false); resetForm(); }} title="Add Script" description="Scripts are injected into all pages served through SplitLab." size="md">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Script Type</label>
              <select value={sType} onChange={(e) => { setSType(e.target.value); setSContent(''); }} className="input-base">
                {SCRIPT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Display Name</label>
              <input type="text" value={sName} onChange={(e) => setSName(e.target.value)} className="input-base" placeholder={`${selectedType.label} — Production`} required />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              {sType === 'custom' ? 'Script Content' : 'ID / Tracking Code'}
            </label>
            {sType === 'custom' ? (
              <textarea
                value={sContent}
                onChange={(e) => setSContent(e.target.value)}
                className="input-base font-mono text-xs resize-none"
                rows={6}
                placeholder='<script>console.log("hello");</script>'
                required
              />
            ) : (
              <input
                type="text"
                value={sContent}
                onChange={(e) => setSContent(e.target.value)}
                className="input-base font-mono"
                placeholder={selectedType.placeholder}
                required
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Placement</label>
              <select value={sPlacement} onChange={(e) => setSPlacement(e.target.value as 'head' | 'body_end')} className="input-base">
                <option value="head">In &lt;head&gt;</option>
                <option value="body_end">Before &lt;/body&gt;</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Apply To</label>
              <select value={sPageId} onChange={(e) => setSPageId(e.target.value)} className="input-base">
                <option value="">All Pages (workspace)</option>
                {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => { setModalOpen(false); resetForm(); }}>Cancel</Button>
            <Button type="submit" loading={saving}>Add Script</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete Script"
        description="This script will stop being injected into pages immediately."
        loading={deleting}
      />
    </>
  );
}
