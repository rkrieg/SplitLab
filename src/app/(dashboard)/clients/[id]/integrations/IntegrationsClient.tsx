'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Flame, CheckCircle2, XCircle, Loader2, ExternalLink } from 'lucide-react';

interface Props {
  workspaceId: string;
  initialProjectId: string | null;
  initialToken: string;
  canManage: boolean;
}

export default function IntegrationsClient({ workspaceId, initialProjectId, initialToken, canManage }: Props) {
  const [saved, setSaved] = useState<string | null>(initialProjectId);
  const [projectDraft, setProjectDraft] = useState(initialProjectId ?? '');
  const [tokenDraft, setTokenDraft] = useState(initialToken ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    const pid = projectDraft.trim();
    if (!/^[a-z0-9]+$/i.test(pid)) {
      toast.error('Enter your Clarity project ID (the code from your Clarity install snippet).');
      return;
    }
    const token = tokenDraft.trim();
    setSaving(true);
    try {
      const config: Record<string, string> = { project_id: pid };
      if (token) config.api_token = token;
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clarity', config }),
      });
      if (!res.ok) { toast.error('Failed to save Clarity settings'); return; }
      setSaved(pid);
      toast.success('Microsoft Clarity connected');
    } catch {
      toast.error('Failed to save Clarity settings');
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    const res = await fetch(`/api/workspaces/${workspaceId}/integrations?type=clarity`, { method: 'DELETE' });
    if (!res.ok) { toast.error('Failed to disconnect Clarity'); return; }
    setSaved(null);
    setProjectDraft('');
    setTokenDraft('');
    toast.success('Microsoft Clarity disconnected');
  }

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Integrations here apply to <strong className="text-slate-700 dark:text-slate-200">this entire client</strong> — every
        test and hosted page. Set them once and they&apos;re on everywhere.
      </p>

      {/* Microsoft Clarity */}
      <div className={`card overflow-hidden ${saved ? 'border-green-500/30' : ''}`}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sky-500/15 flex items-center justify-center">
            <Flame size={16} className="text-sky-600 dark:text-sky-400" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-sm text-slate-800 dark:text-slate-200">Microsoft Clarity</p>
            <p className="text-xs text-slate-500">Free heatmaps &amp; session recordings, tagged per variant — applied to all this client&apos;s hosted pages</p>
          </div>
          {saved && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-green-500">
              <CheckCircle2 size={13} /> Connected
            </span>
          )}
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-slate-500">
            SplitLab injects Clarity on all of this client&apos;s hosted variants and tags each session with <code className="font-mono">sl_variant</code>, so you can filter recordings and heatmaps to a single variant.
          </p>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">Project ID <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={projectDraft}
              onChange={(e) => setProjectDraft(e.target.value)}
              placeholder="e.g. abcd1234ef — from your Clarity install snippet"
              spellCheck={false}
              disabled={!canManage}
              className="input text-sm w-full"
            />
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">Find it in Clarity → Settings → Overview, or in your install snippet.</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">
              Data Export API token <span className="font-normal text-slate-400">(optional — powers AI Insights)</span>
            </label>
            <input
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder="Paste the token here"
              spellCheck={false}
              autoComplete="off"
              disabled={!canManage}
              className="input text-sm w-full"
            />
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
              Get it in Clarity → Settings → Data Export → Generate new API token. Lets SplitLab pull site-wide behavioral signals (rage/dead clicks, scroll depth, JS errors) into AI Insights.
            </p>
          </div>

          {canManage && (
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="btn-primary text-sm px-4 py-2 rounded-lg font-medium flex items-center gap-2"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {saved ? 'Update connection' : 'Connect Clarity'}
              </button>
              {saved && (
                <button
                  onClick={disconnect}
                  className="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition-colors flex items-center gap-1"
                >
                  <XCircle size={13} /> Disconnect
                </button>
              )}
            </div>
          )}

          {saved && (
            <a
              href={`https://clarity.microsoft.com/projects/view/${saved}/dashboard`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-sky-600 dark:text-sky-400 hover:underline"
            >
              <ExternalLink size={12} /> Open Clarity dashboard
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
