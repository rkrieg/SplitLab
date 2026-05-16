import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import Sidebar from '@/components/layout/Sidebar';
import ImpersonationBanner from '@/components/layout/ImpersonationBanner';
import { getUserPlan } from '@/lib/planLimits';
import type { PlanId } from '@/lib/plans';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const userPlan = await getUserPlan(session.user.id) as PlanId;

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-900">
      <Sidebar userPlan={userPlan} />
      <main className="flex-1 flex flex-col min-w-0 overflow-auto">
        <ImpersonationBanner />
        {children}
      </main>
    </div>
  );
}
