import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Sidebar from '@/components/layout/Sidebar';
import VisitorCapBanner from '@/components/layout/VisitorCapBanner';

async function fetchVisitorUsage(cookie: string) {
  try {
    const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const res = await fetch(`${APP_URL}/api/usage`, {
      headers: { cookie },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.visitors ?? null;
  } catch {
    return null;
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  // JWT sessions aren't re-validated against the DB on every request, so a
  // stale token (deleted/recreated account, swapped Supabase project) would
  // otherwise sail through here and only fail later on a FK-constrained
  // insert (e.g. pages.created_by). Catch it here instead, once per load.
  const { data: currentUser } = await db.from('users').select('id').eq('id', session.user.id).single();
  if (!currentUser) redirect('/api/auth/invalidate');

  // Admins have no visitor cap — skip the banner entirely
  let visitorUsage: { used: number; limit: number; limitLabel: string; overCap: boolean } | null = null;
  if (session.user.role !== 'admin') {
    const { cookies } = await import('next/headers');
    const cookieHeader = cookies().toString();
    visitorUsage = await fetchVisitorUsage(cookieHeader);
  }

  const showBanner = visitorUsage !== null && visitorUsage.limit !== null &&
    (visitorUsage.overCap || (visitorUsage.used / visitorUsage.limit) >= 0.8);

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-900">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-auto transition-all duration-200">
        {showBanner && visitorUsage && (
          <VisitorCapBanner
            used={visitorUsage.used}
            limit={visitorUsage.limit}
            limitLabel={visitorUsage.limitLabel}
          />
        )}
        {children}
      </main>
    </div>
  );
}
