'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Eye, Loader2 } from 'lucide-react';

/**
 * Sticky banner shown across the app whenever an admin is impersonating another
 * account. One click returns them to their own admin session.
 */
export default function ImpersonationBanner() {
  const { data: session, update } = useSession();
  const router = useRouter();
  const [returning, setReturning] = useState(false);

  if (!session?.user?.impersonatorId) return null;

  async function stop() {
    setReturning(true);
    try {
      await update({ stopImpersonating: true });
      router.push('/admin');
      router.refresh();
    } catch {
      setReturning(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-400 text-amber-950 text-sm">
      <span className="flex items-center gap-2 min-w-0">
        <Eye size={15} className="flex-shrink-0" />
        <span className="truncate">
          You are viewing as <strong>{session.user.email}</strong>
          {session.user.impersonatorEmail ? <> · signed in as {session.user.impersonatorEmail}</> : null}
        </span>
      </span>
      <button
        onClick={stop}
        disabled={returning}
        className="flex-shrink-0 flex items-center gap-1.5 font-semibold underline hover:no-underline disabled:opacity-60"
      >
        {returning && <Loader2 size={13} className="animate-spin" />}
        Return to admin
      </button>
    </div>
  );
}
