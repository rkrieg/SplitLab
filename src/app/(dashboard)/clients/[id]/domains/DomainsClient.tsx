'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Globe, CheckCircle, XCircle, Copy, AlertCircle, Trash2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { formatDate } from '@/lib/utils';

interface Domain {
  id: string;
  domain: string;
  cname_target: string | null;
  verified: boolean;
  verified_at: string | null;
  created_at: string;
}

interface Props {
  initialDomains: Domain[];
  workspaceId: string;
  appHostname: string;
  canManage: boolean;
}

export default function DomainsClient({ initialDomains, workspaceId, appHostname, canManage }: Props) {
  const [domains, setDomains] = useState(initialDomains);
  const [modalOpen, setModalOpen] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainInput.trim().toLowerCase() }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to add domain');
        return;
      }
      const d = await res.json();
      setDomains((prev) => [d, ...prev]);
      setModalOpen(false);
      setDomainInput('');
      toast.success('Domain added');
    } finally {
      setAdding(false);
    }
  }

  async function handleVerify(domainId: string) {
    setVerifying(domainId);
    try {
      // In production this would do a real DNS check via an API
      // For demo, we'll simulate by marking as verified
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', domain_id: domainId }),
      });

      // Optimistically update for demo purposes
      toast.success('Verification check triggered — DNS propagation may take up to 48 hours.');
    } finally {
      setVerifying(null);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain_id: deleteId }),
      });
      if (!res.ok) {
        toast.error('Failed to delete domain');
        return;
      }
      setDomains((prev) => prev.filter((d) => d.id !== deleteId));
      toast.success('Domain removed');
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <p className="text-slate-400 text-sm">{domains.length} domain{domains.length !== 1 ? 's' : ''}</p>
        {canManage && (
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={16} /> Add Domain
          </Button>
        )}
      </div>

      {/* DNS Instructions */}
      <div className="card p-5 mb-6 border-indigo-500/30 bg-indigo-500/5">
        <div className="flex items-start gap-3">
          <AlertCircle size={18} className="text-indigo-400 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-medium text-slate-200 mb-1 text-sm">DNS Configuration Instructions</h3>
            <p className="text-slate-400 text-xs leading-relaxed">
              To point a custom domain to SplitLab, add a <strong className="text-slate-300">CNAME record</strong> in your DNS provider:
            </p>
            <div className="mt-3 bg-slate-800 rounded-lg p-3 font-mono text-xs text-slate-300 flex items-center justify-between gap-4">
              <span>
                <span className="text-slate-500">Type: </span>CNAME
                {'  '}
                <span className="text-slate-500">Name: </span>@ (or subdomain)
                {'  '}
                <span className="text-slate-500">Value: </span>
                <span className="text-indigo-300">{appHostname}</span>
              </span>
              <button onClick={() => copyToClipboard(appHostname)} className="text-slate-400 hover:text-slate-200 flex-shrink-0">
                <Copy size={14} />
              </button>
            </div>
            <p className="text-slate-500 text-xs mt-2">
              Then add the domain below and click Verify. DNS propagation can take up to 48 hours.
            </p>
          </div>
        </div>
      </div>

      {domains.length === 0 && (
        <EmptyState
          icon={Globe}
          title="No custom domains"
          description="Add your client's custom domain to serve A/B tests on their own URL."
          action={canManage ? <Button onClick={() => setModalOpen(true)}><Plus size={16} /> Add Domain</Button> : undefined}
        />
      )}

      {domains.length > 0 && (
        <div className="space-y-3">
          {domains.map((d) => (
            <div key={d.id} className="card p-5 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Globe size={15} className="text-slate-400 flex-shrink-0" />
                  <span className="font-medium text-slate-100">{d.domain}</span>
                  {d.verified ? (
                    <span className="flex items-center gap-1 badge bg-green-500/20 text-green-400 border-green-500/30">
                      <CheckCircle size={11} /> Verified
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 badge bg-amber-500/20 text-amber-400 border-amber-500/30">
                      <XCircle size={11} /> Pending DNS
                    </span>
                  )}
                </div>
                <p className="text-slate-500 text-xs ml-5">
                  CNAME → {d.cname_target || appHostname} • Added {formatDate(d.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {!d.verified && canManage && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleVerify(d.id)}
                    loading={verifying === d.id}
                  >
                    Verify DNS
                  </Button>
                )}
                {canManage && (
                  <button
                    onClick={() => setDeleteId(d.id)}
                    className="p-2 text-slate-500 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-700"
                    title="Delete domain"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete Domain"
        description="This will remove the domain from this workspace. You will need to re-add it and update DNS records if you want to use it again."
        loading={deleting}
      />

      {/* Add domain modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add Custom Domain" size="sm">
        <form onSubmit={handleAdd} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Domain</label>
            <input
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              className="input-base font-mono"
              placeholder="landing.clientname.com"
              required
              autoFocus
            />
            <p className="text-slate-500 text-xs mt-1.5">Enter the exact domain or subdomain (without https://)</p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" loading={adding}>Add Domain</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
