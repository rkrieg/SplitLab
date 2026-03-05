'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Globe, CheckCircle, XCircle, Copy, AlertCircle, Trash2, Clock } from 'lucide-react';
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
  const [verifyStatus, setVerifyStatus] = useState<Record<string, string>>({});
  const [verifyMessage, setVerifyMessage] = useState<Record<string, string>>({});
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
      toast.success('Domain registered — now configure your DNS records');
    } finally {
      setAdding(false);
    }
  }

  async function handleVerify(domainId: string) {
    setVerifying(domainId);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', domain_id: domainId }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Verification check failed');
        return;
      }

      const result = await res.json();
      setVerifyStatus((prev) => ({ ...prev, [domainId]: result.status }));

      if (result.verified) {
        setDomains((prev) =>
          prev.map((d) =>
            d.id === domainId
              ? { ...d, verified: true, verified_at: new Date().toISOString() }
              : d
          )
        );
        setVerifyMessage((prev) => ({ ...prev, [domainId]: '' }));
        toast.success('Domain verified successfully!');
      } else if (result.status === 'misconfigured') {
        setVerifyMessage((prev) => ({
          ...prev,
          [domainId]: 'DNS records not found. Make sure you\'ve added the CNAME record at your registrar and try again.',
        }));
      } else {
        setVerifyMessage((prev) => ({
          ...prev,
          [domainId]: 'DNS not yet propagated — this can take up to 48 hours. Try again later.',
        }));
      }
    } catch {
      toast.error('Failed to check domain verification');
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
        const err = await res.json();
        toast.error(err.error || 'Failed to delete domain');
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

  function getDomainName(domain: string): string {
    const parts = domain.split('.');
    if (parts.length <= 2) return '@';
    return parts.slice(0, -2).join('.');
  }

  function isRootDomain(domain: string): boolean {
    return domain.split('.').length <= 2;
  }

  function renderDomainCard(d: Domain) {
    const status = verifyStatus[d.id];
    const errorMsg = verifyMessage[d.id];
    const dnsName = getDomainName(d.domain);
    const isRoot = isRootDomain(d.domain);

    if (d.verified) {
      return (
        <div key={d.id} className="card overflow-hidden">
          <div className="p-5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Globe size={15} className="text-green-400 flex-shrink-0" />
                <span className="font-medium text-slate-100">{d.domain}</span>
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25">
                  <CheckCircle size={11} /> Domain Active
                </span>
              </div>
              <p className="text-slate-500 text-xs ml-[23px]">
                Verified {d.verified_at ? formatDate(d.verified_at) : ''} • Added {formatDate(d.created_at)}
              </p>
            </div>
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

          {/* Progress: all steps complete */}
          <div className="border-t border-slate-800 px-5 py-3 bg-green-500/5">
            <div className="flex items-center gap-6 text-xs">
              <span className="flex items-center gap-1.5 text-green-400">
                <CheckCircle size={13} /> Domain registered
              </span>
              <span className="flex items-center gap-1.5 text-green-400">
                <CheckCircle size={13} /> DNS configured
              </span>
              <span className="flex items-center gap-1.5 text-green-400">
                <CheckCircle size={13} /> Verified
              </span>
            </div>
          </div>
        </div>
      );
    }

    // Pending / Misconfigured state
    return (
      <div key={d.id} className="card overflow-hidden">
        {/* Header */}
        <div className="p-5 flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Globe size={15} className="text-slate-400 flex-shrink-0" />
              <span className="font-medium text-slate-100">{d.domain}</span>
              {status === 'misconfigured' ? (
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/25">
                  <XCircle size={11} /> DNS Not Found
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">
                  <Clock size={11} /> Pending DNS
                </span>
              )}
            </div>
            <p className="text-slate-500 text-xs ml-[23px]">Added {formatDate(d.created_at)}</p>
          </div>
          <div className="flex items-center gap-2">
            {canManage && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleVerify(d.id)}
                  loading={verifying === d.id}
                >
                  Verify DNS
                </Button>
                <button
                  onClick={() => setDeleteId(d.id)}
                  className="p-2 text-slate-500 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-700"
                  title="Delete domain"
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Progress indicator */}
        <div className="border-t border-slate-800 px-5 py-3 bg-slate-800/30">
          <div className="flex items-center gap-6 text-xs">
            <span className="flex items-center gap-1.5 text-green-400">
              <CheckCircle size={13} /> Domain registered
            </span>
            <span className="flex items-center gap-1.5 text-amber-400">
              <Clock size={13} /> Configure DNS
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <span className="w-[13px] h-[13px] rounded-full border border-slate-600 flex-shrink-0" /> Verify
            </span>
          </div>
        </div>

        {/* Action banner */}
        <div className="border-t border-amber-500/20 px-5 py-3 bg-amber-500/5 flex items-center gap-2">
          <AlertCircle size={14} className="text-amber-400 flex-shrink-0" />
          <p className="text-amber-300 text-xs font-medium">
            1 step remaining: Update your DNS records below, then click Verify DNS
          </p>
        </div>

        {/* Error message after failed verify */}
        {errorMsg && (
          <div className="border-t border-red-500/20 px-5 py-3 bg-red-500/5 flex items-start gap-2">
            <XCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-red-300 text-xs">{errorMsg}</p>
          </div>
        )}

        {/* Inline DNS instructions */}
        <div className="border-t border-slate-800 px-5 py-4">
          <h4 className="text-xs font-medium text-slate-300 mb-3">
            Add this DNS record at your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.)
          </h4>

          {/* DNS record table */}
          <div className="rounded-lg border border-slate-700 overflow-hidden text-xs">
            <div className="grid grid-cols-3 bg-slate-800/60">
              <div className="px-3 py-2 text-slate-500 font-medium border-r border-slate-700">Type</div>
              <div className="px-3 py-2 text-slate-500 font-medium border-r border-slate-700">Name</div>
              <div className="px-3 py-2 text-slate-500 font-medium">Value</div>
            </div>
            <div className="grid grid-cols-3 bg-slate-900/50">
              <div className="px-3 py-2.5 text-slate-200 font-mono border-r border-slate-700">CNAME</div>
              <div className="px-3 py-2.5 text-slate-200 font-mono border-r border-slate-700">{dnsName}</div>
              <div className="px-3 py-2.5 font-mono flex items-center justify-between gap-2">
                <span className="text-[#3D8BDA]">{d.cname_target || appHostname}</span>
                <button
                  onClick={() => copyToClipboard(d.cname_target || appHostname)}
                  className="text-slate-500 hover:text-slate-300 flex-shrink-0"
                >
                  <Copy size={12} />
                </button>
              </div>
            </div>
          </div>

          {/* Root domain note */}
          {isRoot && (
            <div className="mt-3 rounded-lg border border-slate-700/50 bg-slate-800/30 px-3 py-2.5">
              <p className="text-slate-400 text-xs leading-relaxed">
                <strong className="text-slate-300">Root domain?</strong> Some registrars don&apos;t support CNAME on root domains. Use an <strong className="text-slate-300">A record</strong> instead:
              </p>
              <div className="grid grid-cols-3 mt-2 text-xs font-mono">
                <span className="text-slate-300">A</span>
                <span className="text-slate-300">@</span>
                <span className="text-[#3D8BDA] flex items-center gap-2">
                  76.76.21.21
                  <button
                    onClick={() => copyToClipboard('76.76.21.21')}
                    className="text-slate-500 hover:text-slate-300"
                  >
                    <Copy size={12} />
                  </button>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
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

      {domains.length === 0 && (
        <EmptyState
          icon={Globe}
          title="No custom domains"
          description="Add your client's custom domain to serve A/B tests on their own URL."
          action={canManage ? <Button onClick={() => setModalOpen(true)}><Plus size={16} /> Add Domain</Button> : undefined}
        />
      )}

      {domains.length > 0 && (
        <div className="space-y-4">
          {domains.map((d) => renderDomainCard(d))}
        </div>
      )}

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete Domain"
        description="This will remove the domain from this workspace and from Vercel. You will need to re-add it and update DNS records if you want to use it again."
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
