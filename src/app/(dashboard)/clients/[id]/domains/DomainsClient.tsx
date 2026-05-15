'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  Plus, Globe, CheckCircle, XCircle, Copy, AlertCircle,
  Trash2, Clock, Pencil, Loader2, Check, X, ShieldCheck, ArrowRight,
} from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { formatDate } from '@/lib/utils';

interface VercelVerification {
  type: string;
  domain: string;
  value: string;
}

interface Domain {
  id: string;
  domain: string;
  verified: boolean;
  verified_at: string | null;
  created_at: string;
  vercel_verification?: VercelVerification[];
  fallback_url?: string | null;
}

interface Props {
  clientId: string;
  initialDomains: Domain[];
  workspaceId: string;
  appHostname: string;
  canManage: boolean;
}

function DnsTable({ records, onCopy, highlight }: {
  records: { type: string; name: string; value: string }[];
  onCopy: (v: string) => void;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-lg border overflow-hidden text-xs ${highlight ? 'border-[#3D8BDA]/40' : 'border-slate-200 dark:border-slate-700'}`}>
      <table className="w-full">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700">
            <th className="text-left px-3 py-2 text-slate-500 font-medium w-16">Type</th>
            <th className="text-left px-3 py-2 text-slate-500 font-medium w-24">Name</th>
            <th className="text-left px-3 py-2 text-slate-500 font-medium">Value</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={i} className="bg-white dark:bg-slate-900/40">
              <td className="px-3 py-2.5 font-mono font-semibold text-[#3D8BDA]">{r.type}</td>
              <td className="px-3 py-2.5 font-mono text-slate-700 dark:text-slate-300">{r.name}</td>
              <td className="px-3 py-2.5 font-mono text-slate-700 dark:text-slate-300 break-all">{r.value}</td>
              <td className="px-2 py-2.5">
                <button onClick={() => onCopy(r.value)} className="p-1 text-slate-400 hover:text-slate-200 transition-colors rounded">
                  <Copy size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DomainsClient({ initialDomains, workspaceId, appHostname, canManage }: Props) {
  const [domains, setDomains] = useState(initialDomains);
  const [modalOpen, setModalOpen] = useState(false);
  const [addWebsiteDomain, setAddWebsiteDomain] = useState('');
  const [addPrefix, setAddPrefix] = useState('test');
  const [adding, setAdding] = useState(false);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editDomain, setEditDomain] = useState<Domain | null>(null);
  const [editBaseDomain, setEditBaseDomain] = useState('');
  const [editPrefix, setEditPrefix] = useState('test');
  const [saving, setSaving] = useState(false);

  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyStatus, setVerifyStatus] = useState<Record<string, string>>({});
  const [verifyMessage, setVerifyMessage] = useState<Record<string, string>>({});
  const [verifyTxtRecords, setVerifyTxtRecords] = useState<Record<string, VercelVerification[]>>({});
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [editingFallback, setEditingFallback] = useState<string | null>(null);
  const [fallbackDraft, setFallbackDraft] = useState('');
  const [savingFallback, setSavingFallback] = useState(false);

  function cleanDomain(raw: string) {
    return raw.trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  }

  function getAddPreview() {
    const base = cleanDomain(addWebsiteDomain);
    const prefix = addPrefix.trim().replace(/[^a-zA-Z0-9-]/g, '') || 'test';
    return base ? `${prefix}.${base}` : '';
  }

  function getEditPreview() {
    const base = cleanDomain(editBaseDomain);
    const prefix = editPrefix.trim().replace(/[^a-zA-Z0-9-]/g, '') || 'test';
    return base ? `${prefix}.${base}` : '';
  }

  function getDomainPrefix(domain: string) {
    const parts = domain.split('.');
    return parts.length > 2 ? parts.slice(0, -2).join('.') : '';
  }

  function getBaseDomain(domain: string) { return domain.split('.').slice(-2).join('.'); }
  function copyToClipboard(text: string) { navigator.clipboard.writeText(text); toast.success('Copied!'); }
  function resetAddModal() { setAddWebsiteDomain(''); setAddPrefix('test'); }

  function openEditModal(d: Domain) {
    setEditDomain(d);
    setEditBaseDomain(getBaseDomain(d.domain));
    setEditPrefix(getDomainPrefix(d.domain) || 'test');
    setEditModalOpen(true);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const domain = getAddPreview();
    if (!domain || domain.split('.').length < 3) { toast.error('Enter a valid domain'); return; }
    setAdding(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to add domain'); return; }
      const d = await res.json();
      setDomains(prev => [...prev, d]);
      setModalOpen(false);
      resetAddModal();
      toast.success('Domain added — now configure your DNS record below.');
    } finally { setAdding(false); }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editDomain) return;
    const domain = getEditPreview();
    if (!domain) { toast.error('Enter a valid domain'); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', domain_id: editDomain.id, domain }),
      });
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to update domain'); return; }
      const updated = await res.json();
      setDomains((prev) => prev.map((d) => d.id === editDomain.id ? { ...d, ...updated } : d));
      setEditModalOpen(false);
      toast.success('Domain updated');
    } finally { setSaving(false); }
  }

  async function handleVerify(domainId: string) {
    setVerifying(domainId);
    setVerifyMessage((p) => ({ ...p, [domainId]: '' }));
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', domain_id: domainId }),
      });
      const data = await res.json();
      if (data.verified) {
        setDomains((prev) => prev.map((d) => d.id === domainId ? { ...d, verified: true, verified_at: new Date().toISOString() } : d));
        setVerifyStatus((p) => ({ ...p, [domainId]: '' }));
        toast.success('Domain verified!');
      } else {
        setVerifyStatus((p) => ({ ...p, [domainId]: data.status || 'misconfigured' }));
        setVerifyMessage((p) => ({ ...p, [domainId]: data.message || 'DNS record not found yet.' }));
        if (data.vercel_verification?.length) {
          setVerifyTxtRecords((p) => ({ ...p, [domainId]: data.vercel_verification }));
        } else {
          setVerifyTxtRecords((p) => { const n = { ...p }; delete n[domainId]; return n; });
        }
      }
    } catch { toast.error('Failed to check domain verification'); } finally { setVerifying(null); }
  }

  async function saveFallback(domainId: string) {
    setSavingFallback(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_fallback', domain_id: domainId, fallback_url: fallbackDraft.trim() }),
      });
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to save'); return; }
      setDomains((prev) => prev.map((d) => d.id === domainId ? { ...d, fallback_url: fallbackDraft.trim() || null } : d));
      setEditingFallback(null);
      toast.success(fallbackDraft.trim() ? 'Fallback URL saved' : 'Fallback URL removed');
    } finally { setSavingFallback(false); }
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
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to delete'); return; }
      setDomains((prev) => prev.filter((d) => d.id !== deleteId));
      setDeleteId(null);
      toast.success('Domain removed');
    } finally { setDeleting(false); }
  }

  function renderDomainCard(d: Domain) {
    const status = verifyStatus[d.id];
    const errorMsg = verifyMessage[d.id];
    const activeTxtRecords = verifyTxtRecords[d.id] ?? d.vercel_verification ?? [];
    const prefix = getDomainPrefix(d.domain);
    const base = getBaseDomain(d.domain);

    if (d.verified) {
      const isEditingFb = editingFallback === d.id;
      return (
        <div key={d.id} className="card overflow-hidden">
          <div className="p-5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Globe size={15} className="text-green-400 flex-shrink-0" />
                <span className="font-medium text-slate-900 dark:text-slate-100">{d.domain}</span>
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25"><CheckCircle size={11} /> Active</span>
              </div>
              <p className="text-slate-400 dark:text-slate-500 text-xs ml-[23px]">Verified {d.verified_at ? formatDate(d.verified_at) : ''} • Added {formatDate(d.created_at)}</p>
            </div>
            {canManage && (
              <div className="flex items-center gap-1">
                <button onClick={() => openEditModal(d)} className="p-2 text-slate-500 hover:text-slate-200 transition-colors rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700" title="Edit domain"><Pencil size={14} /></button>
                <button onClick={() => setDeleteId(d.id)} className="p-2 text-slate-500 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700" title="Delete domain"><Trash2 size={14} /></button>
              </div>
            )}
          </div>
          <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-3 bg-green-500/5">
            <div className="flex items-center gap-6 text-xs">
              <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={13} /> Domain registered</span>
              <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={13} /> DNS configured</span>
              <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={13} /> Verified</span>
            </div>
          </div>
          <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-0.5">Fallback URL</p>
                <p className="text-xs text-slate-400 dark:text-slate-500">Where visitors go when no A/B test is running on this domain.</p>
                {!isEditingFb && (
                  <p className="mt-1 text-xs font-mono truncate">
                    {d.fallback_url
                      ? <span className="text-[#3D8BDA]">{d.fallback_url}</span>
                      : <span className="text-slate-500 italic">Not set — visitors will see a placeholder page if no test is active</span>}
                  </p>
                )}
              </div>
              {canManage && !isEditingFb && (
                <button
                  onClick={() => { setEditingFallback(d.id); setFallbackDraft(d.fallback_url || ''); }}
                  className="flex-shrink-0 text-xs text-slate-500 hover:text-slate-200 flex items-center gap-1 mt-0.5"
                ><Pencil size={12} /> {d.fallback_url ? 'Edit' : 'Set'}</button>
              )}
            </div>
            {isEditingFb && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="url"
                  value={fallbackDraft}
                  onChange={e => setFallbackDraft(e.target.value)}
                  className="input-base text-xs font-mono flex-1"
                  placeholder="https://www.yoursite.com"
                  autoFocus
                />
                <button
                  onClick={() => saveFallback(d.id)}
                  disabled={savingFallback}
                  className="flex-shrink-0 flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/30 disabled:opacity-50"
                >{savingFallback ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Save</button>
                <button
                  onClick={() => setEditingFallback(null)}
                  className="flex-shrink-0 flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-500 hover:text-slate-200 border border-slate-300 dark:border-slate-600"
                ><X size={11} /></button>
              </div>
            )}
          </div>
        </div>
      );
    }

    // ── Pending DNS card ──
    return (
      <div key={d.id} className="card overflow-hidden">
        <div className="p-5 flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Globe size={15} className="text-slate-400 flex-shrink-0" />
              <span className="font-medium text-slate-900 dark:text-slate-100">{d.domain}</span>
              {status === 'pending_cname'
                ? <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/25"><XCircle size={11} /> CNAME Not Found</span>
                : <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25"><Clock size={11} /> Pending DNS</span>}
            </div>
            <p className="text-slate-400 dark:text-slate-500 text-xs ml-[23px]">Added {formatDate(d.created_at)}</p>
          </div>
          <div className="flex items-center gap-1">
            {canManage && (
              <>
                <Button variant="secondary" size="sm" onClick={() => handleVerify(d.id)} loading={verifying === d.id}>Verify DNS</Button>
                <button onClick={() => openEditModal(d)} className="p-2 text-slate-500 hover:text-slate-200 transition-colors rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700" title="Edit domain"><Pencil size={14} /></button>
                <button onClick={() => setDeleteId(d.id)} className="p-2 text-slate-500 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700" title="Delete domain"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        </div>

        <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-3 bg-slate-50 dark:bg-slate-800/30">
          <div className="flex items-center gap-6 text-xs">
            <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={13} /> Domain registered</span>
            <span className="flex items-center gap-1.5 text-amber-400"><Clock size={13} /> Configure DNS</span>
            <span className="flex items-center gap-1.5 text-slate-500"><span className="w-[13px] h-[13px] rounded-full border border-slate-600 flex-shrink-0" /> Verify</span>
          </div>
        </div>

        {errorMsg && (
          <div className="border-t border-red-200 dark:border-red-500/20 px-5 py-3 bg-red-50 dark:bg-red-500/5 flex items-start gap-2">
            <XCircle size={14} className="text-red-500 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-red-700 dark:text-red-300 text-xs">{errorMsg}</p>
          </div>
        )}

        <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-5 space-y-4">
          <div className="rounded-lg border border-green-200 dark:border-green-500/25 bg-green-50 dark:bg-green-500/5 px-4 py-3 flex items-start gap-3">
            <ShieldCheck size={15} className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-green-800 dark:text-green-200 leading-relaxed">
              <strong>Your production site stays untouched.</strong>{' '}
              Only <span className="font-mono">{d.domain}</span> points to SplitLab.
              {base && <>{' '}<span className="font-mono font-medium">www.{base}</span> and <span className="font-mono font-medium">{base}</span> continue working normally.</>}
            </div>
          </div>

          <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#3D8BDA]/20 text-[#3D8BDA] text-xs flex items-center justify-center font-bold flex-shrink-0">1</span>
            Log in to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.)
          </p>

          <div>
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-[#3D8BDA]/20 text-[#3D8BDA] text-xs flex items-center justify-center font-bold flex-shrink-0">2</span>
              Add this CNAME record:
            </p>
            <DnsTable
              records={[{ type: 'CNAME', name: prefix || d.domain, value: appHostname }]}
              onCopy={copyToClipboard}
              highlight
            />
            <div className="mt-2 rounded-lg border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/5 px-3 py-2 flex items-start gap-2">
              <AlertCircle size={13} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
                <strong>Using Cloudflare?</strong> Set to <strong>DNS only</strong> (grey cloud), not proxied (orange cloud).
              </p>
            </div>
          </div>

          {activeTxtRecords.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 text-xs flex items-center justify-center font-bold flex-shrink-0">3</span>
                Also add this TXT record in your{' '}
                <a href="https://vercel.com/dashboard/domains" target="_blank" rel="noopener noreferrer" className="text-[#3D8BDA] underline">Vercel DNS panel</a>:
              </p>
              <div className="mb-2 rounded-lg border border-purple-200 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-500/5 px-3 py-2 flex items-start gap-2">
                <AlertCircle size={13} className="text-purple-600 dark:text-purple-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-purple-800 dark:text-purple-200 leading-relaxed">
                  <strong>Why?</strong> Your domain <span className="font-mono">{base}</span> is managed by Vercel. This TXT record proves you own it and authorizes SplitLab to route the <span className="font-mono">{prefix}</span> subdomain. Your main site stays untouched.
                </p>
              </div>
              <DnsTable
                records={activeTxtRecords.map(v => ({ type: v.type, name: v.domain.replace(/\.$/, ''), value: v.value }))}
                onCopy={copyToClipboard}
              />
            </div>
          )}

          <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#3D8BDA]/20 text-[#3D8BDA] text-xs flex items-center justify-center font-bold flex-shrink-0">{activeTxtRecords.length > 0 ? '4' : '3'}</span>
            Come back here and click <strong className="text-[#3D8BDA]">Verify DNS</strong> above
          </p>
          <p className="text-xs text-slate-500">DNS changes can take a few minutes. If Verify fails, wait 5 minutes and try again.</p>
        </div>
      </div>
    );
  }

  const addPreview = getAddPreview();
  const addBase = cleanDomain(addWebsiteDomain);

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {domains.length === 0 ? 'No domains configured yet' : `${domains.length} domain${domains.length !== 1 ? 's' : ''}`}
        </p>
        {canManage && domains.length > 0 && (
          <Button onClick={() => { resetAddModal(); setModalOpen(true); }}>
            <Plus size={16} /> Add Domain
          </Button>
        )}
      </div>

      {domains.length === 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50 p-10 text-center">
          <div className="w-14 h-14 rounded-full bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center mx-auto mb-5">
            <Globe size={28} className="text-blue-500 dark:text-blue-400" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-2">Connect your custom domain</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm max-w-md mx-auto mb-8">
            Run A/B tests on a subdomain (e.g. <span className="font-mono">test.yoursite.com</span>) — your main site stays completely untouched.
          </p>
          <button
            onClick={() => { resetAddModal(); setModalOpen(true); }}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-semibold text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] transition-colors shadow-sm"
          >
            <Plus size={16} /> Add Your Domain
          </button>
        </div>
      )}

      {domains.length > 0 && (
        <div className="space-y-4">
          {domains.map((d) => renderDomainCard(d))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete Domain"
        description="This will remove the domain from this workspace. You will need to re-add it and update DNS records if you want to use it again."
        loading={deleting}
      />

      {/* ── Add Domain Modal ── */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add Test Subdomain" size="sm">
        <form onSubmit={handleAdd} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Your website domain
            </label>
            <input
              type="text"
              value={addWebsiteDomain}
              onChange={e => setAddWebsiteDomain(e.target.value)}
              className="input-base font-mono"
              placeholder="linkedupai.xyz"
              autoFocus
              required
            />
            <p className="text-xs text-slate-500 mt-1">Enter your root domain — without www or https.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Test subdomain prefix
            </label>
            <div className="flex items-center gap-0">
              <input
                type="text"
                value={addPrefix}
                onChange={e => setAddPrefix(e.target.value.replace(/[^a-zA-Z0-9-]/g, ''))}
                className="input-base font-mono rounded-r-none border-r-0 w-28"
                placeholder="test"
              />
              <div className="px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-r-lg text-slate-500 text-sm font-mono whitespace-nowrap">
                .{addBase || 'yoursite.com'}
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-1">Common choices: <button type="button" onClick={() => setAddPrefix('test')} className="text-[#3D8BDA] hover:underline">test</button>, <button type="button" onClick={() => setAddPrefix('ab')} className="text-[#3D8BDA] hover:underline">ab</button>, <button type="button" onClick={() => setAddPrefix('try')} className="text-[#3D8BDA] hover:underline">try</button></p>
          </div>

          {addPreview && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-sm">
              <div className="bg-slate-50 dark:bg-slate-800/60 px-4 py-2 text-xs font-medium text-slate-500 border-b border-slate-200 dark:border-slate-700">Setup preview</div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="font-mono text-xs text-green-400">{addPreview}</span>
                  <span className="text-xs text-slate-500 flex items-center gap-1.5"><ArrowRight size={11} /> SplitLab A/B tests</span>
                </div>
                {addBase && (
                  <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="font-mono text-xs text-slate-400">www.{addBase}</span>
                    <span className="text-xs text-slate-500 flex items-center gap-1.5"><ShieldCheck size={11} className="text-green-500" /> Your site — untouched</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" loading={adding} disabled={!addBase.trim() || !addPrefix.trim()}>Continue</Button>
          </div>
        </form>
      </Modal>

      {/* ── Edit Domain Modal ── */}
      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit Domain" size="sm">
        <form onSubmit={handleEdit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Base Domain</label>
            <input type="text" value={editBaseDomain} onChange={e => setEditBaseDomain(e.target.value)} className="input-base font-mono" placeholder="linkedupai.xyz" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Subdomain Prefix</label>
            <div className="flex items-center gap-0">
              <input type="text" value={editPrefix} onChange={e => setEditPrefix(e.target.value.replace(/[^a-zA-Z0-9-]/g, ''))} className="input-base font-mono rounded-r-none border-r-0 w-28" placeholder="test" />
              <div className="px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-r-lg text-slate-500 text-sm font-mono whitespace-nowrap">.{cleanDomain(editBaseDomain) || 'example.com'}</div>
            </div>
          </div>
          {getEditPreview() && (
            <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 px-3 py-2.5">
              <p className="text-slate-500 text-xs mb-1">Preview</p>
              <p className="font-mono text-sm text-slate-900 dark:text-slate-100">{getEditPreview()}</p>
            </div>
          )}
          <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg px-3 py-2">
            Editing will reset DNS verification — you will need to re-verify after saving.
          </p>
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="secondary" type="button" onClick={() => setEditModalOpen(false)}>Cancel</Button>
            <Button type="submit" loading={saving}>Save Changes</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
