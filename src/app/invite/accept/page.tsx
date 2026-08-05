'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Spinner from '@/components/ui/Spinner';

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInviteInner />
    </Suspense>
  );
}

function AcceptInviteInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { status } = useSession();
  const token = params.get('token');
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (status === 'loading') return;

    if (!token) {
      setState('error');
      setMessage('Missing invite token.');
      return;
    }

    if (status === 'unauthenticated') {
      router.replace(`/login?callbackUrl=${encodeURIComponent(`/invite/accept?token=${token}`)}`);
      return;
    }

    fetch('/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to accept invite');
        setState('done');
        setTimeout(() => router.replace('/dashboard'), 1500);
      })
      .catch((err) => {
        setState('error');
        setMessage(err.message);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, token]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 w-full max-w-sm text-center shadow-xl">
        {state === 'loading' && (
          <>
            <Spinner className="mx-auto mb-4" />
            <p className="text-slate-600 dark:text-slate-400">Accepting invite…</p>
          </>
        )}
        {state === 'done' && (
          <>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">You're in!</h2>
            <p className="text-slate-600 dark:text-slate-400 text-sm">Redirecting to your dashboard…</p>
          </>
        )}
        {state === 'error' && (
          <>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">Couldn't accept invite</h2>
            <p className="text-red-500 text-sm">{message}</p>
          </>
        )}
      </div>
    </div>
  );
}
