'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', error);
  }, [error]);

  return (
    <html>
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0f172a', color: '#f1f5f9' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: '16px', padding: '32px', textAlign: 'center' }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(239,68,68,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>
            ⚠️
          </div>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>Application error</h2>
            <p style={{ fontSize: 14, color: '#94a3b8', margin: 0, maxWidth: 360 }}>
              {error.message || 'A critical error occurred. Please refresh the page.'}
            </p>
          </div>
          <button
            onClick={reset}
            style={{ padding: '8px 20px', borderRadius: 8, background: '#4f46e5', border: 'none', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
