import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
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
      <main className="flex-1 flex flex-col min-w-0 overflow-auto">
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
