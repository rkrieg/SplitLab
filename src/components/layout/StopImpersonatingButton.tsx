'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function StopImpersonatingButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleStop() {
    setLoading(true);
    await fetch('/api/admin/stop-impersonate', { method: 'POST' });
    router.push('/admin');
    router.refresh();
  }

  return (
    <button
      onClick={handleStop}
      disabled={loading}
      className="bg-white text-amber-700 font-semibold text-xs px-3 py-1.5 rounded-lg hover:bg-amber-50 transition-colors disabled:opacity-60"
    >
      {loading ? 'Stopping…' : '✕ Exit Account'}
    </button>
  );
}
