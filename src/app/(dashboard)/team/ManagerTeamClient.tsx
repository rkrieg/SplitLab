'use client';

import { useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { Plus, Users, Trash2, Shield, Lock, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Badge from '@/components/ui/Badge';
import { formatDate } from '@/lib/utils';

const PAGE_SIZE = 10;

interface Member {
  id: string;
  name: string;
  email: string;
  status: string;
  created_at: string;
  workspaceRole: 'manager' | 'viewer';
}

interface Props {
  initialMembers: Member[];
  seatLimit: number;
  currentUserId: string;
}

const ROLE_BADGE: Record<string, 'info' | 'default'> = {
  manager: 'info',
  viewer: 'default',
};

export default function ManagerTeamClient({ initialMembers, seatLimit, currentUserId }: Props) {
  const [members, setMembers] = useState(initialMembers);
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [inviteError, setInviteError] = useState<{ message: string; isLimit: boolean } | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'manager' | 'viewer'>('viewer');

  const totalPages  = Math.max(1, Math.ceil(members.length / PAGE_SIZE));
  const safePage    = Math.min(page, totalPages);
  const pageMembers = members.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Owner always occupies 1 seat, so available invite slots = seatLimit - 1
  const usedSeats = members.length + 1; // +1 for the owner
  const atLimit = isFinite(seatLimit) && usedSeats >= seatLimit;
  const noSeats = seatLimit === 0;

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, role }),
      });
      const json = await res.json();
      if (!res.ok) {
        const msg = json.error || 'Failed to invite member';
        setInviteError({ message: msg, isLimit: res.status === 403 });
        return;
      }
      setMembers((prev) => [json, ...prev]);
      setPage(1); // jump to first page so new entry is visible
      setModalOpen(false);
      resetForm();
      if (json.emailError) {
        toast.error(`Member added but invite email failed: ${json.emailError}`);
      } else {
        toast.success('Invite sent successfully');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/team/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) { toast.error('Failed to remove member'); return; }
      setMembers((prev) => {
        const next = prev.filter((m) => m.id !== deleteId);
        const newTotal = Math.max(1, Math.ceil(next.length / PAGE_SIZE));
        if (safePage > newTotal) setPage(newTotal);
        return next;
      });
      toast.success('Member removed');
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  }

  function resetForm() {
    setName(''); setEmail(''); setPassword(''); setRole('viewer'); setInviteError(null);
  }

  // ── Free plan — no seats available ──────────────────────────────────────────
  if (noSeats) {
    return (
      <div className="card p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
          <Lock size={22} className="text-slate-400" />
        </div>
        <h3 className="text-base font-semibold text-slate-800 dark:text-slate-200 mb-2">Team seats not included</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-5 max-w-sm mx-auto">
          Your current plan does not include team seats. Upgrade to Pro or higher to invite collaborators.
        </p>
        <Link href="/billing">
          <Button>Upgrade plan</Button>
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <p className="text-slate-500 dark:text-slate-400 text-sm">
          {usedSeats} of {isFinite(seatLimit) ? seatLimit : '∞'} seat{seatLimit !== 1 ? 's' : ''} used
        </p>
        <div className="flex items-center gap-3">
          {atLimit && (
            <Link href="/billing" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              Upgrade for more seats
            </Link>
          )}
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={16} /> Invite Member
          </Button>
        </div>
      </div>

      {members.length === 0 && (
        <EmptyState
          icon={Users}
          title="No team members yet"
          description="Invite a colleague to collaborate on your tests and pages."
          action={<Button onClick={() => setModalOpen(true)}><Plus size={16} /> Invite Member</Button>}
        />
      )}

      {members.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Name</th>
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Email</th>
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Role</th>
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Status</th>
                <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Joined</th>
                <th className="text-center px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageMembers.map((member) => (
                <tr key={member.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/20">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-indigo-600/80 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                        {member.name[0].toUpperCase()}
                      </div>
                      <span className="font-medium text-slate-800 dark:text-slate-200">{member.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400">{member.email}</td>
                  <td className="px-5 py-3.5">
                    <Badge variant={ROLE_BADGE[member.workspaceRole] || 'default'} className="capitalize">
                      <Shield size={10} className="mr-1" />
                      {member.workspaceRole === 'manager' ? 'Manager' : 'Viewer'}
                    </Badge>
                  </td>
                  <td className="px-5 py-3.5">
                    <Badge variant={member.status === 'active' ? 'success' : 'default'}>
                      {member.status}
                    </Badge>
                  </td>
                  <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400">{formatDate(member.created_at)}</td>
                  <td className="px-5 py-3.5 text-center">
                    {member.id !== currentUserId && (
                      <button
                        onClick={() => setDeleteId(member.id)}
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

          {/* Pagination footer */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-700">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, members.length)} of {members.length}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="text-xs text-slate-500 dark:text-slate-400 px-2 tabular-nums">
                  {safePage} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Invite modal */}
      <Modal open={modalOpen} onClose={() => { setModalOpen(false); resetForm(); }} title="Invite Team Member" size="sm">
        {atLimit ? (
          <div className="text-center py-4">
            <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-4">
              <AlertCircle size={22} className="text-amber-400" />
            </div>
            <h3 className="text-base font-semibold text-slate-800 dark:text-slate-200 mb-2">
              Team seat limit reached
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-5 max-w-sm mx-auto">
              You&apos;re using {usedSeats} of {seatLimit} seat{seatLimit !== 1 ? 's' : ''} on your current plan. Upgrade to add more team members.
            </p>
            <div className="flex justify-center gap-3">
              <Button variant="secondary" onClick={() => { setModalOpen(false); resetForm(); }}>Cancel</Button>
              <Link href="/billing">
                <Button>Upgrade Plan</Button>
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleInvite} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Full Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-base" placeholder="Jane Smith" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input-base" placeholder="jane@company.com" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Temporary Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input-base" placeholder="Min. 8 characters" required minLength={8} />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value as 'manager' | 'viewer')} className="input-base">
                <option value="viewer">Viewer — read-only access</option>
                <option value="manager">Manager — can manage tests & pages</option>
              </select>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              They will receive an email with these credentials to log in.
            </p>
            {inviteError && (
              <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5 text-sm text-red-400">
                <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                <span>
                  {inviteError.message}
                  {inviteError.isLimit && (
                    <> · <a href="/billing" className="underline font-medium hover:text-red-300">Upgrade Plan</a></>
                  )}
                </span>
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="secondary" type="button" onClick={() => { setModalOpen(false); resetForm(); }}>Cancel</Button>
              <Button type="submit" loading={saving}>Send Invite</Button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleRemove}
        title="Remove Team Member"
        description="This person will lose access to all your workspaces. Their account will be deleted."
        confirmLabel="Remove"
        loading={deleting}
      />
    </>
  );
}
