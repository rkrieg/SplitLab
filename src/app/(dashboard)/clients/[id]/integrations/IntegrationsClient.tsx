'use client';

import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Flame, CheckCircle2, XCircle, Loader2, ExternalLink, Webhook, Plus, Trash2, Users } from 'lucide-react';

interface GlobalWebhook { id: string; url: string; format: 'json' | 'form' | 'xml' }

interface Props {
  workspaceId: string;
  clientId: string;
  initialProjectId: string | null;
  initialToken: string;
  hubspotConnected: boolean;
  hubspotHubId: string | null;
  initialGlobalWebhooks: GlobalWebhook[];
  canManage: boolean;
}

export default function IntegrationsClient({
  workspaceId, clientId, initialProjectId, initialToken,
  hubspotConnected, hubspotHubId, initialGlobalWebhooks, canManage,
}: Props) {
  // ── Clarity ──
  const [claritySaved, setClaritySaved] = useState<string | null>(initialProjectId);
  const [projectDraft, setProjectDraft] = useState(initialProjectId ?? '');
  const [tokenDraft, setTokenDraft] = useState(initialToken ?? '');
  const [claritySaving, setClaritySaving] = useState(false);

  // ── HubSpot ──
  const [hsConnected, setHsConnected] = useState(hubspotConnected);
  const [hsDisconnecting, setHsDisconnecting] = useState(false);

  // ── Global webhooks ──
  const [webhooks, setWebhooks] = useState<GlobalWebhook[]>(initialGlobalWebhooks);
  const [newUrl, setNewUrl] = useState('');
  const [newFormat, setNewFormat] = useState<'json' | 'form' | 'xml'>('json');
  const [addingWebhook, setAddingWebhook] = useState(false);
  const [deletingWebhookId, setDeletingWebhookId] = useState<string | null>(null);

  // Toast on return from HubSpot OAuth
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('hs_connected')) { toast.success('HubSpot connected'); setHsConnected(true); }
    if (p.get('hs_error')) toast.error(`HubSpot connection failed: ${p.get('hs_error')}`);
    if (p.get('hs_connected') || p.get('hs_error')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // ── Clarity handlers ──
  async function saveClarity() {
    const pid = projectDraft.trim();
    if (!/^[a-z0-9]+$/i.test(pid)) { toast.error('Enter your Clarity project ID (from your install snippet).'); return; }
    const token = tokenDraft.trim();
    setClaritySaving(true);
    try {
      const config: Record<string, string> = { project_id: pid };
      if (token) config.api_token = token;
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clarity', config }),
      });
      if (!res.ok) { toast.error('Failed to save Clarity settings'); return; }
      setClaritySaved(pid);
      toast.success('Microsoft Clarity connected');
    } catch { toast.error('Failed to save Clarity settings'); }
    finally { setClaritySaving(false); }
  }
  async function disconnectClarity() {
    const res = await fetch(`/api/workspaces/${workspaceId}/integrations?type=clarity`, { method: 'DELETE' });
    if (!res.ok) { toast.error('Failed to disconnect Clarity'); return; }
    setClaritySaved(null); setProjectDraft(''); setTokenDraft('');
    toast.success('Microsoft Clarity disconnected');
  }

  // ── HubSpot handlers ──
  const hsConnectHref = `/api/integrations/hubspot/connect?workspaceId=${workspaceId}&returnTo=${encodeURIComponent(`/clients/${clientId}/integrations?hs_connected=1`)}`;
  async function disconnectHubSpot() {
    setHsDisconnecting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations?type=hubspot`, { method: 'DELETE' });
      if (!res.ok) { toast.error('Failed to disconnect HubSpot'); return; }
      setHsConnected(false);
      toast.success('HubSpot disconnected');
    } finally { setHsDisconnecting(false); }
  }

  // ── Global webhook handlers ──
  async function addWebhook() {
    const url = newUrl.trim();
    if (!/^https?:\/\//i.test(url)) { toast.error('Enter a valid webhook URL (https://…).'); return; }
    setAddingWebhook(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'webhook', config: { url, format: newFormat, headers: [], global: true } }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.integration?.id) { toast.error('Failed to add webhook'); return; }
      setWebhooks(w => [...w, { id: d.integration.id, url, format: newFormat }]);
      setNewUrl(''); setNewFormat('json');
      toast.success('Global webhook added — it now fires on every test');
    } catch { toast.error('Failed to add webhook'); }
    finally { setAddingWebhook(false); }
  }
  async function deleteWebhook(id: string) {
    setDeletingWebhookId(id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations?integrationId=${id}`, { method: 'DELETE' });
      if (!res.ok) { toast.error('Failed to remove webhook'); return; }
      setWebhooks(w => w.filter(x => x.id !== id));
      toast.success('Webhook removed');
    } finally { setDeletingWebhookId(null); }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Integrations here apply to <strong className="text-slate-700 dark:text-slate-200">this entire client</strong> — every
        test and hosted page. Set them once and they&apos;re on everywhere.
      </p>

      {/* ── Microsoft Clarity ── */}
      <div className={`card overflow-hidden ${claritySaved ? 'border-green-500/30' : ''}`}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sky-500/15 flex items-center justify-center flex-shrink-0">
            <Flame size={16} className="text-sky-600 dark:text-sky-400" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-sm text-slate-800 dark:text-slate-200">Microsoft Clarity</p>
            <p className="text-xs text-slate-500">Free heatmaps &amp; session recordings, tagged per variant</p>
          </div>
          {claritySaved && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-green-500 flex-shrink-0">
              <CheckCircle2 size={13} /> Connected
            </span>
          )}
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">Project ID <span className="text-red-500">*</span></label>
            <input type="text" value={projectDraft} onChange={e => setProjectDraft(e.target.value)} placeholder="e.g. abcd1234ef — from your Clarity install snippet" spellCheck={false} disabled={!canManage} className="input text-sm w-full" />
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">Find it in Clarity → Settings → Overview, or in your install snippet.</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">Data Export API token <span className="font-normal text-slate-400">(optional — powers AI Insights)</span></label>
            <input type="password" value={tokenDraft} onChange={e => setTokenDraft(e.target.value)} placeholder="Paste the token here" spellCheck={false} autoComplete="off" disabled={!canManage} className="input text-sm w-full" />
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">Clarity → Settings → Data Export → Generate new API token. Powers site-wide behavioral signals in AI Insights.</p>
          </div>
          {canManage && (
            <div className="flex items-center gap-3 pt-1">
              <button onClick={saveClarity} disabled={claritySaving} className="btn-primary text-sm px-4 py-2 rounded-lg font-medium flex items-center gap-2">
                {claritySaving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {claritySaved ? 'Update connection' : 'Connect Clarity'}
              </button>
              {claritySaved && (
                <button onClick={disconnectClarity} className="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition-colors flex items-center gap-1">
                  <XCircle size={13} /> Disconnect
                </button>
              )}
            </div>
          )}
          {claritySaved && (
            <a href={`https://clarity.microsoft.com/projects/view/${claritySaved}/dashboard`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-sky-600 dark:text-sky-400 hover:underline">
              <ExternalLink size={12} /> Open Clarity dashboard
            </a>
          )}
        </div>
      </div>

      {/* ── HubSpot ── */}
      <div className={`card overflow-hidden ${hsConnected ? 'border-green-500/30' : ''}`}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center flex-shrink-0">
            <Users size={16} className="text-orange-600 dark:text-orange-400" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-sm text-slate-800 dark:text-slate-200">HubSpot</p>
            <p className="text-xs text-slate-500">Connect your account once; map each test&apos;s form &amp; fields in that test&apos;s Integrations tab</p>
          </div>
          {hsConnected && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-green-500 flex-shrink-0">
              <CheckCircle2 size={13} /> Connected
            </span>
          )}
        </div>
        <div className="px-5 py-4 space-y-3">
          {hsConnected ? (
            <>
              <p className="text-xs text-slate-500">
                Connected{hubspotHubId ? <> to portal <span className="font-mono text-slate-600 dark:text-slate-300">{hubspotHubId}</span></> : ''}. Set up which HubSpot form and fields each test syncs to from that test&apos;s <strong>Integrations</strong> tab.
              </p>
              {canManage && (
                <button onClick={disconnectHubSpot} disabled={hsDisconnecting} className="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition-colors flex items-center gap-1">
                  {hsDisconnecting ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />} Disconnect
                </button>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500">Authorize SplitLab to push leads into HubSpot. One connection covers every test for this client.</p>
              {canManage && (
                <a href={hsConnectHref} className="btn-primary text-sm px-4 py-2 rounded-lg font-medium inline-flex items-center gap-2">
                  <Users size={14} /> Connect HubSpot
                </a>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Global webhook (Zapier / Make / CRM) ── */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-500/15 flex items-center justify-center flex-shrink-0">
            <Webhook size={16} className="text-violet-600 dark:text-violet-400" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-sm text-slate-800 dark:text-slate-200">Outbound webhook <span className="font-normal text-slate-400">(Zapier / Make / CRM)</span></p>
            <p className="text-xs text-slate-500">Send <strong>every</strong> lead from this client to a URL. Paste a Zapier Catch Hook URL and you&apos;re done.</p>
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          {webhooks.length > 0 && (
            <div className="space-y-2">
              {webhooks.map(w => (
                <div key={w.id} className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2">
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-300 truncate flex-1">{w.url}</span>
                  <span className="text-[10px] uppercase font-semibold text-slate-400 flex-shrink-0">{w.format}</span>
                  {canManage && (
                    <button onClick={() => deleteWebhook(w.id)} disabled={deletingWebhookId === w.id} className="text-red-500 hover:text-red-600 dark:hover:text-red-400 flex-shrink-0" title="Remove webhook">
                      {deletingWebhookId === w.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManage && (
            <div className="flex items-center gap-2">
              <input type="url" value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/…" spellCheck={false} className="input text-sm flex-1" />
              <select value={newFormat} onChange={e => setNewFormat(e.target.value as 'json' | 'form' | 'xml')} className="input text-sm w-24 flex-shrink-0">
                <option value="json">JSON</option>
                <option value="form">Form</option>
                <option value="xml">XML</option>
              </select>
              <button onClick={addWebhook} disabled={addingWebhook} className="btn-primary text-sm px-3 py-2 rounded-lg font-medium flex-shrink-0 flex items-center gap-1.5">
                {addingWebhook ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
              </button>
            </div>
          )}
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            Sends all form fields plus system values (test, variant, UTMs, click IDs). For a webhook that fires on only <em>one</em> test, use that test&apos;s Integrations → Webhooks tab instead.
          </p>
        </div>
      </div>
    </div>
  );
}
