'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Save } from 'lucide-react';
import Button from '@/components/ui/Button';

interface Props {
  client: { id: string; name: string; slug: string };
  workspaceId: string;
  canManage: boolean;
}

export default function ClientSettingsClient({ client, canManage }: Props) {
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
      <section>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">Client Name</h2>
        <form onSubmit={handleSaveName} className="card p-5">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Name</label>
              <input
                type="text"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
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
    </div>
  );
}
