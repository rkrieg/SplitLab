'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Copy, Save, Code2 } from 'lucide-react';
import Button from '@/components/ui/Button';

interface Props {
  client: { id: string; name: string; slug: string };
  appUrl: string;
  canManage: boolean;
}

export default function ClientSettingsClient({ client, appUrl, canManage }: Props) {
  const router = useRouter();
  const [clientName, setClientName] = useState(client.name);
  const [savingName, setSavingName] = useState(false);

  async function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    if (!clientName.trim() || clientName === client.name) return;
    setSavingName(true);
    try {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clientName.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to update name');
        return;
      }
      toast.success('Client name updated');
      router.refresh();
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setSavingName(false);
    }
  }

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Client Name */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">Client Name</h2>
        <form onSubmit={handleSaveName} className="card p-5">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Name</label>
              <input
                type="text"
                value={clientName}
                onChange={e => setClientName(e.target.value)}
                className="input-base"
                required
                disabled={!canManage}
              />
            </div>
            {canManage && (
              <Button type="submit" loading={savingName} disabled={clientName === client.name || !clientName.trim()}>
                <Save size={14} /> Save
              </Button>
            )}
          </div>
        </form>
      </section>

      {/* Tracking Setup */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">Tracking Setup</h2>
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
              <Code2 size={16} className="text-indigo-400" />
            </div>
            <div>
              <p className="font-medium text-slate-800 dark:text-slate-200 text-sm">tracker.js</p>
              <p className="text-slate-500 text-xs">Add this script to any external landing page to track conversions automatically</p>
            </div>
          </div>
          <div className="px-5 py-4 space-y-3">
            <p className="text-slate-500 dark:text-slate-400 text-xs">
              Paste before <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">&lt;/body&gt;</code> on your destination page. The script auto-detects button clicks, form submits, and call link clicks.
            </p>
            <div className="flex items-center gap-2">
              <pre className="flex-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-xs text-slate-700 dark:text-slate-300 font-mono overflow-x-auto">
                {`<script src="${appUrl}/tracker.js"></script>`}
              </pre>
              <button
                onClick={() => { navigator.clipboard.writeText(`<script src="${appUrl}/tracker.js"></script>`); toast.success('Copied'); }}
                className="btn-secondary text-xs flex-shrink-0"
              >
                <Copy size={12} /> Copy
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
