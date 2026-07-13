'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Save, User, Lock, Info, ImageIcon, Trash2, Upload } from 'lucide-react';
import Button from '@/components/ui/Button';

interface Props {
  client: { id: string; name: string; slug: string; logo_url?: string | null };
  appUrl: string;
  canManage: boolean;
  user: { id: string; name: string; email: string; role: string };
}

export default function ClientSettingsClient({ client, appUrl, canManage, user }: Props) {
  const router = useRouter();
  const [clientName, setClientName] = useState(client.name);
  const [savingName, setSavingName] = useState(false);

  // Logo state
  const [logoUrl, setLogoUrl] = useState<string | null>(client.logo_url ?? null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [removingLogo, setRemovingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

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

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast.error('File too large. Max 1MB');
      e.target.value = '';
      return;
    }
    setUploadingLogo(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/clients/${client.id}/logo`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to upload logo');
        return;
      }
      setLogoUrl(data.logo_url);
      toast.success('Logo uploaded — it will now show as the favicon on test pages');
      router.refresh();
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setUploadingLogo(false);
      e.target.value = '';
    }
  }

  async function handleRemoveLogo() {
    setRemovingLogo(true);
    try {
      const res = await fetch(`/api/clients/${client.id}/logo`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to remove logo');
        return;
      }
      setLogoUrl(null);
      toast.success('Logo removed');
      router.refresh();
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setRemovingLogo(false);
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

      {/* Logo / Favicon */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">Logo &amp; Favicon</h2>
        <div className="card p-5">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 flex items-center justify-center overflow-hidden shrink-0">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="Client logo" className="w-full h-full object-contain" />
              ) : (
                <ImageIcon size={20} className="text-slate-400 dark:text-slate-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-slate-700 dark:text-slate-300">
                {logoUrl ? 'This logo is shown as the favicon on served test pages.' : 'Upload a logo to use as the favicon on served test pages.'}
              </p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">PNG, JPG or ICO — max 1MB. Square images work best.</p>
            </div>
            {canManage && (
              <div className="flex items-center gap-2 shrink-0">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/x-icon,image/vnd.microsoft.icon"
                  className="hidden"
                  onChange={handleLogoUpload}
                />
                <Button type="button" loading={uploadingLogo} onClick={() => logoInputRef.current?.click()}>
                  <Upload size={14} /> {logoUrl ? 'Replace' : 'Upload'}
                </Button>
                {logoUrl && (
                  <Button type="button" variant="secondary" loading={removingLogo} onClick={handleRemoveLogo}>
                    <Trash2 size={14} /> Remove
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
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
