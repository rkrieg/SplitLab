'use client';

import { useState, useRef } from 'react';
import toast from 'react-hot-toast';
import {
  UserPlus, Trash2, Crown, Eye, Copy, ExternalLink, X, ChevronDown, Users,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import EmptyState from '@/components/ui/EmptyState';

interface Member {
  id: string;
  role: 'manager' | 'viewer';
  user_id: string;
  users: { id: string; name: string; email: string; role: string } | null;
}

interface Props {
  workspaceId: string;
  canManage: boolean;
  currentUserId: string;
  initialMembers: Member[];
}

const ROLE_LABELS: Record<string, string> = {
  manager: 'Manager',
  viewer: 'Viewer',
  admin: 'Admin',
  super_admin: 'Super Admin',
};

export default function WorkspaceTeamClient({ workspaceId, canManage, currentUserId, initialMembers }: Props) {
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const inviteFormRef = useRef<HTMLDivElement>(null);

  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'manager' | 'viewer'>('manager');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url: string; email: string } | null>(null);

  const [removeId, setRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState(false);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim() || !inviteName.trim()) return;
    setInviting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), name: inviteName.trim(), role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Failed to invite member'); return; }

      const newMember: Member = {
        id: data.id,
        role: data.role,
        user_id: data.user_id,
        users: { id: data.user_id, name: data.name, email: data.email, role: data.role },
      };
      setMembers(prev => [...prev, newMember]);

      if (data.invite_url) {
        setInviteResult({ url: data.invite_url, email: data.email });
      } else {
        toast.success(`${data.name} has been added to this workspace`);
      }
      setInviteName('');
      setInviteEmail('');
    } catch { toast.error('An unexpected error occurred'); }
    finally { setInviting(false); }
  }

  async function handleRemove() {
    if (!removeId) return;
    const member = members.find(m => m.user_id === removeId);
    setRemovingId(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members/${removeId}`, { method: 'DELETE' });
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to remove member'); return; }
      setMembers(prev => prev.filter(m => m.user_id !== removeId));
      toast.success(`${member?.users?.name || 'Member'} removed`);
      setRemoveId(null);
    } catch { toast.error('An unexpected error occurred'); }
    finally { setRemovingId(false); }
  }

  async function handleRoleChange(userId: string, newRole: 'manager' | 'viewer') {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Failed to update role'); return; }
      setMembers(prev => prev.map(m => m.user_id === userId ? { ...m, role: newRole } : m));
      toast.success('Role updated');
    } catch { toast.error('An unexpected error occurred'); }
  }

  function copyInviteUrl(url: string) {
    navigator.clipboard.writeText(url);
    toast.success('Invite link copied!');
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Member list */}
      {members.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No team members yet"
          description="Invite people to give them access to this workspace."
          action={canManage ? (
            <Button onClick={() => inviteFormRef.current?.scrollIntoView({ behavior: 'smooth' })}>
              <UserPlus size={16} /> Invite Member
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="card divide-y divide-slate-200 dark:divide-slate-700 overflow-hidden">
          {members.map(m => {
            const user = m.users;
            const isSelf = m.user_id === currentUserId;
            const canEditRole = canManage && !isSelf && ['manager', 'viewer'].includes(m.role);
            return (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3.5">
                <div className="w-9 h-9 rounded-full bg-[#3D8BDA]/20 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-semibold text-[#3D8BDA]">
                    {(user?.name || '?').charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{user?.name || '—'}</span>
                    {isSelf && <span className="text-xs text-slate-400 dark:text-slate-500">(you)</span>}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{user?.email || '—'}</p>
                </div>
                <div className="flex items-center gap-2">
                  {canEditRole ? (
                    <div className="relative">
                      <select
                        value={m.role}
                        onChange={e => handleRoleChange(m.user_id, e.target.value as 'manager' | 'viewer')}
                        className="text-xs pl-2 pr-6 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 appearance-none cursor-pointer"
                      >
                        <option value="manager">Manager</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <ChevronDown size={10} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                    </div>
                  ) : (
                    <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
                      {['manager', 'admin', 'super_admin'].includes(m.role) ? <Crown size={10} /> : <Eye size={10} />}
                      {ROLE_LABELS[m.role] || m.role}
                    </span>
                  )}
                  {canManage && !isSelf && (
                    <button
                      onClick={() => setRemoveId(m.user_id)}
                      className="p-1.5 text-slate-400 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10"
                      title="Remove member"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Invite result banner */}
      {inviteResult && (
        <div className="rounded-xl border border-green-200 dark:border-green-500/25 bg-green-50 dark:bg-green-500/5 p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <p className="text-sm font-semibold text-green-800 dark:text-green-200">Invite link created!</p>
              <p className="text-xs text-green-700 dark:text-green-300 mt-0.5">
                Send this link to <strong>{inviteResult.email}</strong>. It expires in 7 days.
              </p>
            </div>
            <button onClick={() => setInviteResult(null)} className="text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-200">
              <X size={14} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white dark:bg-slate-900 border border-green-200 dark:border-green-500/25 rounded-lg px-3 py-2 font-mono text-slate-700 dark:text-slate-300 truncate">
              {inviteResult.url}
            </code>
            <button
              onClick={() => copyInviteUrl(inviteResult.url)}
              className="flex-shrink-0 flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-green-500/20 text-green-700 dark:text-green-300 hover:bg-green-500/30 border border-green-500/30 transition-colors"
            >
              <Copy size={12} /> Copy
            </button>
            <a
              href={inviteResult.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600 transition-colors"
            >
              <ExternalLink size={12} /> Open
            </a>
          </div>
        </div>
      )}

      {/* Invite form */}
      {canManage && (
        <div ref={inviteFormRef}>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2">
            <UserPlus size={14} /> Invite a team member
          </h3>
          <form onSubmit={handleInvite} className="card p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Full name</label>
                <input
                  type="text"
                  value={inviteName}
                  onChange={e => setInviteName(e.target.value)}
                  className="input-base text-sm"
                  placeholder="Jane Smith"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Email address</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  className="input-base text-sm"
                  placeholder="jane@company.com"
                  required
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Role</label>
                <div className="flex gap-2">
                  {(['manager', 'viewer'] as const).map(r => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setInviteRole(r)}
                      className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                        inviteRole === r
                          ? 'bg-[#3D8BDA]/15 text-[#3D8BDA] border-[#3D8BDA]/30'
                          : 'bg-white dark:bg-slate-800 text-slate-500 border-slate-300 dark:border-slate-600 hover:border-slate-400'
                      }`}
                    >
                      {r === 'manager' ? <Crown size={11} /> : <Eye size={11} />}
                      {r === 'manager' ? 'Manager' : 'Viewer'}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {inviteRole === 'manager' ? 'Can create and edit tests, view analytics.' : 'Read-only access to tests and analytics.'}
                </p>
              </div>
              <div className="flex-shrink-0 self-end">
                <Button type="submit" loading={inviting} disabled={!inviteEmail.trim() || !inviteName.trim()}>
                  <UserPlus size={14} /> Send Invite
                </Button>
              </div>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={!!removeId}
        onClose={() => setRemoveId(null)}
        onConfirm={handleRemove}
        title="Remove Member"
        description="This person will lose access to this workspace immediately."
        loading={removingId}
      />
    </div>
  );
}
