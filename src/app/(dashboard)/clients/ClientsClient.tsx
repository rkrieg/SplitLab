'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Plus, Building2, FlaskConical, ChevronRight } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { slugify } from '@/lib/utils';

interface Client {
  id: string;
  name: string;
  slug: string;
  status: string;
  workspaces: Array<{
    id: string;
    name: string;
    status: string;
    tests: Array<{ id: string; status: string }>;
  }>;
}

interface Props {
  initialClients: Client[];
  canManage: boolean;
}

export default function ClientsClient({ initialClients, canManage }: Props) {
  const router = useRouter();
  const [clients, setClients] = useState(initialClients);
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);

    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug: slugify(name.trim()) }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to create client');
        return;
      }

      const client = await res.json();
      setClients((prev) => [{ ...client, workspaces: [] }, ...prev]);
      setModalOpen(false);
      setName('');
      toast.success(`Client "${client.name}" created`);
      router.refresh();
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-6">
        <p className="text-slate-400 text-sm">{clients.length} client{clients.length !== 1 ? 's' : ''}</p>
        {canManage && (
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={16} /> New Client
          </Button>
        )}
      </div>

      {/* Empty state */}
      {clients.length === 0 && (
        <EmptyState
          icon={Building2}
          title="No clients yet"
          description="Create your first client to start managing workspaces and A/B tests."
          action={
            canManage ? (
              <Button onClick={() => setModalOpen(true)}>
                <Plus size={16} /> New Client
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Client grid */}
      {clients.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {clients.map((client) => {
            const workspaces = client.workspaces ?? [];
            const activeTests = workspaces.flatMap((w) =>
              (w.tests ?? []).filter((t) => t.status === 'active')
            ).length;
            const totalTests = workspaces.flatMap((w) => w.tests ?? []).length;

            return (
              <Link
                key={client.id}
                href={`/clients/${client.id}`}
                className="card p-5 hover:border-indigo-500/50 transition-colors group"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
                    <Building2 size={18} className="text-indigo-400" />
                  </div>
                  <ChevronRight size={16} className="text-slate-600 group-hover:text-slate-400 transition-colors mt-1" />
                </div>

                <h3 className="font-semibold text-slate-100 mb-0.5">{client.name}</h3>
                <p className="text-slate-500 text-xs mb-4">/{client.slug}</p>

                <div className="flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-1.5 text-slate-400">
                    <FlaskConical size={14} />
                    <span>{activeTests} active</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-500 text-xs">
                    {totalTests} total tests
                  </div>
                </div>

                {client.status === 'archived' && (
                  <span className="badge bg-slate-600 text-slate-400 mt-3 block w-fit">archived</span>
                )}
              </Link>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="New Client"
        description="Add a new client workspace to the platform."
        size="sm"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Client Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-base"
              placeholder="Acme Corp"
              autoFocus
              required
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={creating}>
              Create Client
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
