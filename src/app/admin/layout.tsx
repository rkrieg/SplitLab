import Link from 'next/link';
import { requireAdmin } from '@/lib/admin-auth';
import { LayoutDashboard, Users, ArrowLeft, ShieldCheck } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-7xl mx-auto px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="flex items-center gap-2 font-semibold">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-600 text-white">
                <ShieldCheck size={16} />
              </span>
              <span>SplitLab <span className="text-indigo-600 dark:text-indigo-400">Admin</span></span>
            </Link>
            <nav className="flex items-center gap-1">
              <Link href="/admin" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                <LayoutDashboard size={15} /> Dashboard
              </Link>
              <Link href="/admin/users" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                <Users size={15} /> Users
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-slate-500 dark:text-slate-400 hidden sm:inline">{session.user.email}</span>
            <Link href="/dashboard" className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
              <ArrowLeft size={15} /> Back to app
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-5 py-8">{children}</main>
    </div>
  );
}
