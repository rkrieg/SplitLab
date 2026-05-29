'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Save, User, Lock, Info } from 'lucide-react';
import Button from '@/components/ui/Button';

interface Props {
  client: { id: string; name: string; slug: string };
  appUrl: string;
  canManage: boolean;
  user: { id: string; name: string; email: string; role: string };
}

export default function ClientSettingsClient({ client, appUrl, canManage, user }: Props) {
  const router = useRouter();
  const [clientName, setClientName] = useState(client.name);
  const [savingName, setSavingName] = useState(false);

  // Profile state
  const [userName, setUserName] = useState(user.name);
  const [userEmail, setUserEmail] = useState(user.email);
  const [savingProfile, setSavingProfile] = useState(false);

  // Password state
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

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

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: userName, email: userEmail }),
      });
      if (!res.ok) { toast.error('Failed to save profile'); return; }
      toast.success('Profile updated');
      router.refresh();
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleSavePassword(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    setSavingPassword(true);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) { toast.error('Failed to update password'); return; }
      setPassword('');
      setConfirmPassword('');
      toast.success('Password updated');
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
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

      {/* Profile section */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-5">
          <User size={16} className="text-slate-500 dark:text-slate-400" />
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">Profile</h2>
        </div>
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Display Name</label>
            <input type="text" value={userName} onChange={(e) => setUserName(e.target.value)} className="input-base" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Email</label>
            <input type="email" value={userEmail} onChange={(e) => setUserEmail(e.target.value)} className="input-base" required />
          </div>
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1.5 text-slate-400 dark:text-slate-500 text-xs">
              <Info size={12} />
              Role: <span className="capitalize text-slate-500 dark:text-slate-400">{user.role}</span>
            </div>
            <Button type="submit" loading={savingProfile}>Save Profile</Button>
          </div>
        </form>
      </div>

      {/* Password section */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-5">
          <Lock size={16} className="text-slate-500 dark:text-slate-400" />
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">Change Password</h2>
        </div>
        <form onSubmit={handleSavePassword} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">New Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input-base" placeholder="Min. 8 characters" minLength={8} required />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Confirm Password</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="input-base" required />
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={savingPassword}>Update Password</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
