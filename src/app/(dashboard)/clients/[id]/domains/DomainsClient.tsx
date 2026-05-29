'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  Plus, Globe, CheckCircle, XCircle, Copy, AlertCircle,
  Trash2, Clock, Pencil, ChevronDown,
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
  cname_target: string | null;
  verified: boolean;
  verified_at: string | null;
  created_at: string;
  vercel_verification?: VercelVerification[] | null;
}

interface Props {
  initialDomains: Domain[];
  workspaceId: string;
  appHostname: string;
  appARecord: string;
  canManage: boolean;
  canAddDomain: boolean;
}

export default function DomainsClient({ initialDomains, workspaceId, appHostname, appARecord, canManage, canAddDomain }: Props) {
  const [domains, setDomains] = useState(initialDomains);
  const [modalOpen, setModalOpen] = useState(false);
  const [upgradeAlertOpen, setUpgradeAlertOpen] = useState(false);
  const [addBaseDomain, setAddBaseDomain] = useState('');
  const [addMode, setAddMode] = useState<'root' | 'subdomain'>('root');
  const [addSubdomain, setAddSubdomain] = useState('');
  const [adding, setAdding] = useState(false);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editDomain, setEditDomain] = useState<Domain | null>(null);
  const [editBaseDomain, setEditBaseDomain] = useState('');
  const [editMode, setEditMode] = useState<'root' | 'subdomain'>('root');
  const [editSubdomain, setEditSubdomain] = useState('');
  const [saving, setSaving] = useState(false);

  const [addDomainError, setAddDomainError] = useState<{ message: string; isLimit: boolean } | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyStatus, setVerifyStatus] = useState<Record<string, string>>({});
  const [verifyMessage, setVerifyMessage] = useState<Record<string, string>>({});
  const [verifyTxtRecords, setVerifyTxtRecords] = useState<Record<string, VercelVerification[]>>({});
  const [showDnsId, setShowDnsId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ─── Helpers ────────────────────────────────────────────────────────────

  function buildFullDomain(base: string, mode: 'root' | 'subdomain', sub: string): string {
    const clean = base.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return mode === 'subdomain' && sub.trim() ? `${sub.trim().toLowerCase()}.${clean}` : clean;
  }

  const getAddPreview  = () => buildFullDomain(addBaseDomain, addMode, addSubdomain);
  const getEditPreview = () => buildFullDomain(editBaseDomain, editMode, editSubdomain);

  function getDomainName(domain: string)  { const p = domain.split('.'); return p.length <= 2 ? '@' : p.slice(0, -2).join('.'); }
  function isRootDomain(domain: string)   { return domain.split('.').length <= 2; }
  function getBaseDomain(domain: string)  { return domain.split('.').slice(-2).join('.'); }
  function getSubdomainPart(domain: string) { const p = domain.split('.'); return p.length <= 2 ? '' : p.slice(0, -2).join('.'); }

  function copyToClipboard(text: string) { navigator.clipboard.writeText(text); toast.success('Copied to clipboard'); }
  function resetAddModal() { setAddBaseDomain(''); setAddMode('root'); setAddSubdomain(''); setAddDomainError(null); }

  function openEditModal(d: Domain) {
    setEditDomain(d);
    setEditBaseDomain(getBaseDomain(d.domain));
    const sub = getSubdomainPart(d.domain);
    if (sub) { setEditMode('subdomain'); setEditSubdomain(sub); } else { setEditMode('root'); setEditSubdomain(''); }
    setEditModalOpen(true);
  }

  // ─── API Handlers ────────────────────────────────────────────────────────

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const domain = getAddPreview();
    if (!domain || domain.split('.').length < 2) { toast.error('Enter a valid domain'); return; }
    const cleanBase = addBaseDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!cleanBase.includes('.')) { toast.error('Enter the full domain including the TLD — e.g. example.com, not just example'); return; }
    setAdding(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) {
        const err = await res.json();
        const msg = err.error || 'Failed to add domain';
        toast.error(msg);
        setAddDomainError({ message: msg, isLimit: !!err.limitError });
        return;
      }
      const d = await res.json();
      setDomains(prev => [d, ...prev]);
      setModalOpen(false);
      resetAddModal();
      toast.success('Domain registered — now configure your DNS records');
    } finally { setAdding(false); }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editDomain) return;
    const newDomain = getEditPreview();
    if (!newDomain || newDomain.split('.').length < 2) { toast.error('Enter a valid domain'); return; }
    const cleanBase = editBaseDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!cleanBase.includes('.')) { toast.error('Enter the full domain including the TLD — e.g. example.com, not just example'); return; }
    if (newDomain === editDomain.domain) { setEditModalOpen(false); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', domain_id: editDomain.id, domain: newDomain }),
      });
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to update domain'); return; }
      const updated = await res.json();
      setDomains(prev => prev.map(d => d.id === updated.id ? updated : d));
      setVerifyStatus(prev => { const n = { ...prev }; delete n[editDomain.id]; return n; });
      setVerifyMessage(prev => { const n = { ...prev }; delete n[editDomain.id]; return n; });
      setEditModalOpen(false);
      toast.success('Domain updated — configure DNS for the new domain');
    } finally { setSaving(false); }
  }

  async function handleVerify(domainId: string) {
    setVerifying(domainId);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', domain_id: domainId }),
      });
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Verification check failed'); return; }
      const result = await res.json();
      const statusStr = result.status?.status ?? result.status;
      setVerifyStatus(prev => ({ ...prev, [domainId]: statusStr }));
      if (result.verified) {
        setDomains(prev => prev.map(d => d.id === domainId ? { ...d, verified: true, verified_at: new Date().toISOString() } : d));
        setVerifyMessage(prev => ({ ...prev, [domainId]: '' }));
        setVerifyTxtRecords(prev => { const n = { ...prev }; delete n[domainId]; return n; });
        toast.success('Domain verified successfully!');
      } else if (statusStr === 'needs_txt') {
        setVerifyTxtRecords(prev => ({ ...prev, [domainId]: result.status?.vercel_verification || [] }));
        setVerifyMessage(prev => ({ ...prev, [domainId]: result.status?.message || 'Add the TXT record below, then click Verify DNS again.' }));
      } else if (statusStr === 'misconfigured') {
        setVerifyMessage(prev => ({ ...prev, [domainId]: "DNS records not found. Make sure you've added the CNAME record at your registrar and try again." }));
      } else {
        setVerifyMessage(prev => ({ ...prev, [domainId]: 'DNS not yet propagated — this can take up to 48 hours. Try again later.' }));
      }
    } catch { toast.error('Failed to check domain verification'); } finally { setVerifying(null); }
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
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to delete domain'); return; }
      setDomains(prev => prev.filter(d => d.id !== deleteId));
      toast.success('Domain removed');
    } finally { setDeleting(false); setDeleteId(null); }
  }

  // ─── Mode Selector ───────────────────────────────────────────────────────

  function renderModeSelector(
    mode: 'root' | 'subdomain',
    setMode: (m: 'root' | 'subdomain') => void,
    baseDomain: string,
    setBaseDomainFn: (v: string) => void,
    subdomain: string,
    setSubdomainFn: (v: string) => void,
    preview: string,
  ) {
    return (
      <>
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Base Domain</label>
          <input type="text" value={baseDomain} onChange={e => setBaseDomainFn(e.target.value)} className="input-base font-mono" placeholder="example.com" required />
          {baseDomain.trim() && !baseDomain.replace(/^https?:\/\//, '').includes('.') && (
            <p className="text-amber-400 text-xs mt-1.5">Include the TLD — e.g. <span className="font-mono">example.com</span>, not just <span className="font-mono">example</span></p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Type</label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setMode('root')} className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${mode === 'root' ? 'bg-[#3D8BDA]/15 border-[#3D8BDA]/40 text-[#3D8BDA]' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'}`}>
              Root domain (@)
            </button>
            <button type="button" onClick={() => setMode('subdomain')} className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${mode === 'subdomain' ? 'bg-[#3D8BDA]/15 border-[#3D8BDA]/40 text-[#3D8BDA]' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'}`}>
              Subdomain
            </button>
          </div>
        </div>
        {mode === 'subdomain' && (
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Subdomain Prefix</label>
            <div className="flex items-center gap-0">
              <input type="text" value={subdomain} onChange={e => setSubdomainFn(e.target.value.replace(/[^a-zA-Z0-9-]/g, ''))} className="input-base font-mono rounded-r-none border-r-0" placeholder="testing" required autoFocus />
              <div className="px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-r-lg text-slate-500 text-sm font-mono whitespace-nowrap">.{baseDomain.trim().toLowerCase() || 'example.com'}</div>
            </div>
          </div>
        )}
        {baseDomain.trim() && (
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 px-3 py-2.5">
            <p className="text-slate-500 text-xs mb-1">Domain preview</p>
            <p className="text-slate-900 dark:text-slate-100 font-mono text-sm">{preview || '—'}</p>
          </div>
        )}
      </>
    );
  }

  // ─── Domain Card ─────────────────────────────────────────────────────────

  function renderDomainCard(d: Domain) {
    const status = verifyStatus[d.id];
    const errorMsg = verifyMessage[d.id];
    const dnsName = getDomainName(d.domain);
    const isRoot = isRootDomain(d.domain);
    const activeTxtRecords = verifyTxtRecords[d.id] ?? d.vercel_verification ?? [];

    if (d.verified) {
      const dnsExpanded = showDnsId === d.id;
      const txtRecords: VercelVerification[] = d.vercel_verification ?? [];
      return (
        <div key={d.id} className="card overflow-hidden">
          <div className="p-5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Globe size={15} className="text-green-400 flex-shrink-0" />
                <span className="font-medium text-slate-900 dark:text-slate-100">{d.domain}</span>
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25">
                  <CheckCircle size={11} /> Domain Active
                </span>
              </div>
              <p className="text-slate-400 dark:text-slate-500 text-xs ml-[23px]">
                Verified {d.verified_at ? formatDate(d.verified_at) : ''} • Added {formatDate(d.created_at)}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowDnsId(dnsExpanded ? null : d.id)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors"
                title="View DNS records"
              >
                DNS Records
                <ChevronDown size={12} className={`transition-transform ${dnsExpanded ? 'rotate-180' : ''}`} />
              </button>
              {canManage && (
                <>
                  <button onClick={() => openEditModal(d)} className="p-2 text-slate-500 hover:text-slate-200 transition-colors rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700" title="Edit domain">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => setDeleteId(d.id)} className="p-2 text-slate-500 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700" title="Delete domain">
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-3 bg-green-500/5">
            <div className="flex items-center gap-6 text-xs">
              <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={13} /> Domain registered</span>
              <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={13} /> DNS configured</span>
              <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={13} /> Verified</span>
            </div>
          </div>
          {dnsExpanded && (
            <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-4">
              <p className="text-xs text-slate-500 mb-3 font-medium">DNS Configuration (reference only — already configured)</p>
              <div className="rounded-lg border border-slate-700 overflow-hidden text-xs">
                <div className="grid grid-cols-3 bg-slate-50 dark:bg-slate-800/60">
                  <div className="px-3 py-2 text-slate-500 font-medium border-r border-slate-200 dark:border-slate-700">Type</div>
                  <div className="px-3 py-2 text-slate-500 font-medium border-r border-slate-200 dark:border-slate-700">Name</div>
                  <div className="px-3 py-2 text-slate-500 font-medium">Value</div>
                </div>
                <div className="grid grid-cols-3 bg-white dark:bg-slate-900/50">
                  <div className="px-3 py-2.5 text-slate-800 dark:text-slate-200 font-mono border-r border-slate-200 dark:border-slate-700">CNAME</div>
                  <div className="px-3 py-2.5 text-slate-800 dark:text-slate-200 font-mono border-r border-slate-200 dark:border-slate-700">{dnsName}</div>
                  <div className="px-3 py-2.5 font-mono flex items-center justify-between gap-2">
                    <span className="text-[#3D8BDA]">{d.cname_target || appHostname}</span>
                    <button onClick={() => copyToClipboard(d.cname_target || appHostname)} className="text-slate-500 hover:text-slate-300 flex-shrink-0"><Copy size={12} /></button>
                  </div>
                </div>
              </div>
              {isRoot && (
                <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/30 px-3 py-2.5">
                  <p className="text-slate-400 text-xs leading-relaxed">
                    <strong className="text-slate-700 dark:text-slate-300">Root domain?</strong> If you used an <strong className="text-slate-700 dark:text-slate-300">A record</strong> instead of CNAME:
                  </p>
                  <div className="grid grid-cols-3 mt-2 text-xs font-mono">
                    <span className="text-slate-700 dark:text-slate-300">A</span>
                    <span className="text-slate-700 dark:text-slate-300">@</span>
                    <span className="text-[#3D8BDA] flex items-center gap-2">
                      {appARecord}
                      <button onClick={() => copyToClipboard(appARecord)} className="text-slate-500 hover:text-slate-300"><Copy size={12} /></button>
                    </span>
                  </div>
                </div>
              )}
              {txtRecords.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">TXT record (domain ownership verification):</h4>
                  <div className="rounded-lg border border-slate-700 overflow-hidden text-xs">
                    <div className="grid grid-cols-3 bg-slate-50 dark:bg-slate-800/60">
                      <div className="px-3 py-2 text-slate-500 font-medium border-r border-slate-200 dark:border-slate-700">Type</div>
                      <div className="px-3 py-2 text-slate-500 font-medium border-r border-slate-200 dark:border-slate-700">Name</div>
                      <div className="px-3 py-2 text-slate-500 font-medium">Value</div>
                    </div>
                    {txtRecords.map((rec, i) => (
                      <div key={i} className="grid grid-cols-3 bg-white dark:bg-slate-900/50">
                        <div className="px-3 py-2.5 text-slate-800 dark:text-slate-200 font-mono border-r border-slate-200 dark:border-slate-700">{rec.type}</div>
                        <div className="px-3 py-2.5 text-slate-800 dark:text-slate-200 font-mono border-r border-slate-200 dark:border-slate-700 break-all">
                          {rec.domain}
                          <button onClick={() => copyToClipboard(rec.domain)} className="ml-2 text-slate-500 hover:text-slate-300 inline-flex"><Copy size={11} /></button>
                        </div>
                        <div className="px-3 py-2.5 font-mono flex items-start justify-between gap-2">
                          <span className="text-slate-300 break-all">{rec.value}</span>
                          <button onClick={() => copyToClipboard(rec.value)} className="text-slate-500 hover:text-slate-300 flex-shrink-0 mt-0.5"><Copy size={11} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    return (
      <div key={d.id} className="card overflow-hidden">
        <div className="p-5 flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Globe size={15} className="text-slate-400 flex-shrink-0" />
              <span className="font-medium text-slate-900 dark:text-slate-100">{d.domain}</span>
              {status === 'misconfigured' ? (
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/25"><XCircle size={11} /> DNS Not Found</span>
              ) : (
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25"><Clock size={11} /> Pending DNS</span>
              )}
            </div>
            <p className="text-slate-400 dark:text-slate-500 text-xs ml-[23px]">Added {formatDate(d.created_at)}</p>
          </div>
          {canManage && (
            <div className="flex items-center gap-1">
              <Button variant="secondary" size="sm" onClick={() => handleVerify(d.id)} loading={verifying === d.id}>
                Verify DNS
              </Button>
              <button onClick={() => openEditModal(d)} className="p-2 text-slate-500 hover:text-slate-200 transition-colors rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700" title="Edit domain">
                <Pencil size={14} />
              </button>
              <button onClick={() => setDeleteId(d.id)} className="p-2 text-slate-500 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700" title="Delete domain">
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-3 bg-slate-50 dark:bg-slate-800/30">
          <div className="flex items-center gap-6 text-xs">
            <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={13} /> Domain registered</span>
            <span className="flex items-center gap-1.5 text-amber-400"><Clock size={13} /> Configure DNS</span>
            <span className="flex items-center gap-1.5 text-slate-500"><span className="w-[13px] h-[13px] rounded-full border border-slate-600 flex-shrink-0" /> Verify</span>
          </div>
        </div>

        <div className="border-t border-amber-500/20 px-5 py-3 bg-amber-500/5 flex items-center gap-2">
          <AlertCircle size={14} className="text-amber-400 flex-shrink-0" />
          <p className="text-amber-300 text-xs font-medium">1 step remaining: Update your DNS records below, then click Verify DNS</p>
        </div>

        {errorMsg && (
          <div className="border-t border-red-500/20 px-5 py-3 bg-red-500/5 flex items-start gap-2">
            <XCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-red-300 text-xs">{errorMsg}</p>
          </div>
        )}

        <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-4">
          <h4 className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-3">
            Point your domain to SplitLab by adding this DNS record at your registrar (GoDaddy, Namecheap, Cloudflare, etc.)
          </h4>
          <div className="rounded-lg border border-slate-700 overflow-hidden text-xs">
            <div className="grid grid-cols-3 bg-slate-50 dark:bg-slate-800/60">
              <div className="px-3 py-2 text-slate-500 font-medium border-r border-slate-200 dark:border-slate-700">Type</div>
              <div className="px-3 py-2 text-slate-500 font-medium border-r border-slate-200 dark:border-slate-700">Name</div>
              <div className="px-3 py-2 text-slate-500 font-medium">Value</div>
            </div>
            <div className="grid grid-cols-3 bg-white dark:bg-slate-900/50">
              <div className="px-3 py-2.5 text-slate-800 dark:text-slate-200 font-mono border-r border-slate-200 dark:border-slate-700">CNAME</div>
              <div className="px-3 py-2.5 text-slate-800 dark:text-slate-200 font-mono border-r border-slate-200 dark:border-slate-700">{dnsName}</div>
              <div className="px-3 py-2.5 font-mono flex items-center justify-between gap-2">
                <span className="text-[#3D8BDA]">{d.cname_target || appHostname}</span>
                <button onClick={() => copyToClipboard(d.cname_target || appHostname)} className="text-slate-500 hover:text-slate-300 flex-shrink-0">
                  <Copy size={12} />
                </button>
              </div>
            </div>
          </div>

          {isRoot && (
            <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/30 px-3 py-2.5">
              <p className="text-slate-400 text-xs leading-relaxed">
                <strong className="text-slate-700 dark:text-slate-300">Root domain?</strong> Some registrars don&apos;t support CNAME on root domains. Use an <strong className="text-slate-700 dark:text-slate-300">A record</strong> instead:
              </p>
              <div className="grid grid-cols-3 mt-2 text-xs font-mono">
                <span className="text-slate-700 dark:text-slate-300">A</span>
                <span className="text-slate-700 dark:text-slate-300">@</span>
                <span className="text-[#3D8BDA] flex items-center gap-2">
                  {appARecord}
                  <button onClick={() => copyToClipboard(appARecord)} className="text-slate-500 hover:text-slate-300"><Copy size={12} /></button>
                </span>
              </div>
            </div>
          )}

          {activeTxtRecords.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">Also add this TXT record to verify domain ownership:</h4>
              <div className="rounded-lg border border-amber-500/30 overflow-hidden text-xs">
                <div className="grid grid-cols-3 bg-amber-500/10">
                  <div className="px-3 py-2 text-slate-500 font-medium border-r border-amber-500/20">Type</div>
                  <div className="px-3 py-2 text-slate-500 font-medium border-r border-amber-500/20">Name</div>
                  <div className="px-3 py-2 text-slate-500 font-medium">Value</div>
                </div>
                {activeTxtRecords.map((rec, i) => (
                  <div key={i} className="grid grid-cols-3 bg-white dark:bg-slate-900/50">
                    <div className="px-3 py-2.5 text-slate-800 dark:text-slate-200 font-mono border-r border-amber-500/20">{rec.type}</div>
                    <div className="px-3 py-2.5 text-slate-800 dark:text-slate-200 font-mono border-r border-amber-500/20 break-all">
                      {rec.domain}
                      <button onClick={() => copyToClipboard(rec.domain)} className="ml-2 text-slate-500 hover:text-slate-300 inline-flex"><Copy size={11} /></button>
                    </div>
                    <div className="px-3 py-2.5 font-mono flex items-start justify-between gap-2">
                      <span className="text-amber-400 break-all">{rec.value}</span>
                      <button onClick={() => copyToClipboard(rec.value)} className="text-slate-500 hover:text-slate-300 flex-shrink-0 mt-0.5"><Copy size={11} /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Custom Domain{domains.length > 1 ? 's' : ''}</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-0.5">
            Route A/B test traffic through your client&apos;s own URL.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => { if (!canAddDomain) { setUpgradeAlertOpen(true); return; } resetAddModal(); setModalOpen(true); }}>
            <Plus size={16} /> Add Domain
          </Button>
        )}
      </div>

      {domains.length === 0 ? (
        <div className="card p-10 text-center">
          <Globe className="mx-auto text-slate-600 mb-3" size={32} />
          <p className="text-slate-500 dark:text-slate-400 text-sm mb-1">No custom domain configured</p>
          <p className="text-slate-400 dark:text-slate-500 text-xs max-w-xs mx-auto">
            Add a custom domain to serve A/B tests on your client&apos;s own URL.
          </p>
          {canManage && (
            <button onClick={() => { if (!canAddDomain) { setUpgradeAlertOpen(true); return; } resetAddModal(); setModalOpen(true); }} className="btn-primary mt-4 text-sm">
              <Plus size={14} /> Add Domain
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {domains.map(d => renderDomainCard(d))}
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
      <Modal open={modalOpen} onClose={() => { setModalOpen(false); setAddDomainError(null); }} title="Add Custom Domain" size="sm">
        <form onSubmit={handleAdd} className="space-y-4">
          {renderModeSelector(addMode, setAddMode, addBaseDomain, setAddBaseDomain, addSubdomain, setAddSubdomain, getAddPreview())}
          {addDomainError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5 text-sm text-red-400">
              {addDomainError.message}
              {addDomainError.isLimit && (
                <> · <a href="/billing" className="underline font-medium hover:text-red-300">Upgrade Plan</a></>
              )}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => { setModalOpen(false); setAddDomainError(null); }}>Cancel</Button>
            <Button type="submit" loading={adding} disabled={!addBaseDomain.trim()}>Add Domain</Button>
          </div>
        </form>
      </Modal>

      {/* Edit domain modal */}
      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit Domain" size="sm">
        <form onSubmit={handleEdit} className="space-y-4">
          {renderModeSelector(editMode, setEditMode, editBaseDomain, setEditBaseDomain, editSubdomain, setEditSubdomain, getEditPreview())}
          <p className="text-slate-400 dark:text-slate-500 text-xs">
            Changing the domain will reset its verification status. You&apos;ll need to update DNS records for the new domain.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => setEditModalOpen(false)}>Cancel</Button>
            <Button type="submit" loading={saving} disabled={!editBaseDomain.trim()}>Save Changes</Button>
          </div>
        </form>
      </Modal>

      {/* Upgrade required alert */}
      {upgradeAlertOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
                <Globe size={18} className="text-indigo-400" />
              </div>
              <button onClick={() => setUpgradeAlertOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                <XCircle size={18} />
              </button>
            </div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">Custom Domains require a paid plan</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">
              Please update your plan to add a domain.{' '}
            </p>
            <a
              href="/billing"
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors"
            >
              Upgrade Plan
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
