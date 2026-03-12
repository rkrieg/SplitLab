'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { User, Lock, Info, Cpu } from 'lucide-react';
import Button from '@/components/ui/Button';

interface Props {
  user: { id: string; name: string; email: string; role: string };
}

export default function SettingsClient({ user }: Props) {
  const [name, setName] = useState(user.name);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [aiDebug, setAiDebug] = useState<Record<string, unknown> | null>(null);
  const [testingAi, setTestingAi] = useState(false);

  async function handleTestAI() {
    setTestingAi(true);
    setAiDebug(null);
    try {
      const res = await fetch('/api/ai/debug');
      const data = await res.json();
      setAiDebug(data);
      if (data.api_test === 'SUCCESS') {
        toast.success('AI API key is working!');
      } else if (data.api_test === 'FAILED') {
        toast.error(`AI API failed: ${data.api_error}`);
      } else if (!data.key_exists) {
        toast.error('ANTHROPIC_API_KEY not set in environment');
      }
    } catch {
      toast.error('Failed to reach debug endpoint');
    } finally {
      setTestingAi(false);
    }
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) { toast.error('Failed to save profile'); return; }
      toast.success('Profile updated');
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
    <div className="max-w-2xl space-y-6">
      {/* Profile section */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-5">
          <User size={16} className="text-slate-500 dark:text-slate-400" />
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">Profile</h2>
        </div>
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Display Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-base" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Email</label>
            <input type="email" value={user.email} className="input-base opacity-50" disabled />
            <p className="text-slate-400 dark:text-slate-500 text-xs mt-1">Email cannot be changed. Contact an admin if needed.</p>
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
      {/* AI API Key Debug */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-5">
          <Cpu size={16} className="text-slate-500 dark:text-slate-400" />
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">AI Configuration</h2>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Test the Anthropic API key configured in your environment.
        </p>
        <Button onClick={handleTestAI} loading={testingAi}>Test AI API Key</Button>
        {aiDebug && (
          <pre className="mt-4 p-4 bg-slate-900 text-green-400 rounded-lg text-xs overflow-auto max-h-64">
            {JSON.stringify(aiDebug, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
