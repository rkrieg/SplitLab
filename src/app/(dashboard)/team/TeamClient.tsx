'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Users, Trash2, Shield } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Badge from '@/components/ui/Badge';
import { formatDate } from '@/lib/utils';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
}

interface Props {
  initialUsers: User[];
  currentUserId: string;
}

const ROLE_BADGE: Record<string, 'purple' | 'info' | 'default'> = {
  admin: 'purple',
  manager: 'info',
  viewer: 'default',
};

export default function TeamClient({ initialUsers, currentUserId }: Props) {
  const [users, setUsers] = useState(initialUsers);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'manager' | 'viewer'>('viewer');

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, role }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to create user');
        return;
      }
      const user = await res.json();
      setUsers((prev) => [user, ...prev]);
      setModalOpen(false);
      resetForm();
      if (user.emailError) {
        toast.error(`User created but invite email failed: ${user.emailError}`);
      } else {
        toast.success('User created and invite email sent');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/users/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) { toast.error('Delete failed'); return; }
      setUsers((prev) => prev.filter((u) => u.id !== deleteId));
      toast.success('User removed');
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  }

  function resetForm() {
    setName(''); setEmail(''); setPassword(''); setRole('viewer');
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <p className="text-slate-400 text-sm">{users.length} team member{users.length !== 1 ? 's' : ''}</p>
        <Button onClick={() => setModalOpen(true)}>
          <Plus size={16} /> Invite User
        </Button>
      </div>

      {users.length === 0 && (
        <EmptyState
          icon={Users}
          title="No team members"
          description="Invite team members to manage client workspaces."
          action={<Button onClick={() => setModalOpen(true)}><Plus size={16} /> Invite User</Button>}
        />
      )}

      {users.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700">
                <th className="text-left px-5 py-3 text-slate-400 font-medium">Name</th>
                <th className="text-left px-5 py-3 text-slate-400 font-medium">Email</th>
                <th className="text-left px-5 py-3 text-slate-400 font-medium">Role</th>
                <th className="text-left px-5 py-3 text-slate-400 font-medium">Status</th>
                <th className="text-left px-5 py-3 text-slate-400 font-medium">Joined</th>
                <th className="text-center px-5 py-3 text-slate-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-indigo-600/80 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                        {user.name[0].toUpperCase()}
                      </div>
                      <span className="font-medium text-slate-200">{user.name}</span>
                      {user.id === currentUserId && (
                        <span className="badge bg-slate-700 text-slate-400 text-[10px]">You</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400">{user.email}</td>
                  <td className="px-5 py-3.5">
                    <Badge variant={ROLE_BADGE[user.role] || 'default'} className="capitalize">
                      <Shield size={10} className="mr-1" />
                      {user.role}
                    </Badge>
                  </td>
                  <td className="px-5 py-3.5">
                    <Badge variant={user.status === 'active' ? 'success' : 'default'}>
                      {user.status}
                    </Badge>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400">{formatDate(user.created_at)}</td>
                  <td className="px-5 py-3.5 text-center">
                    {user.id !== currentUserId && (
                      <button
                        onClick={() => setDeleteId(user.id)}
                        className="text-slate-500 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      <Modal open={modalOpen} onClose={() => { setModalOpen(false); resetForm(); }} title="Invite Team Member" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Full Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-base" placeholder="Jane Smith" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input-base" placeholder="jane@agency.com" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Temporary Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input-base" placeholder="Min. 8 characters" required minLength={8} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'manager' | 'viewer')} className="input-base">
              <option value="viewer">Viewer — read-only access</option>
              <option value="manager">Manager — manage clients & tests</option>
              <option value="admin">Admin — full access + user management</option>
            </select>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => { setModalOpen(false); resetForm(); }}>Cancel</Button>
            <Button type="submit" loading={saving}>Create User</Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Remove Team Member"
        description="This user will no longer be able to access the platform."
        confirmLabel="Remove"
        loading={deleting}
      />
    </>
  );
}
