'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  if (
    error.message === 'NEXT_REDIRECT' ||
    error.message === 'NEXT_NOT_FOUND' ||
    error.digest?.startsWith('NEXT_REDIRECT') ||
    error.digest?.startsWith('NEXT_NOT_FOUND')
  ) {
    throw error;
  }

  useEffect(() => {
    console.error('[dashboard-error]', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 p-8 text-center">
      <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-500/20 flex items-center justify-center">
        <AlertTriangle size={24} className="text-red-500" />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Something went wrong
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-sm">
          {error.message || 'An unexpected error occurred. Please try again.'}
        </p>
      </div>
      <button
        onClick={reset}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors"
      >
        <RefreshCw size={14} />
        Try again
      </button>
    </div>
  );
}
