import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { FileCode2, Tag } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import { formatDate } from '@/lib/utils';

async function getAllPages() {
  const { data } = await db
    .from('pages')
    .select('*, workspaces(name, client_id, clients(name))')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  return data ?? [];
}

export default async function AllPagesPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const pages = await getAllPages();

  return (
    <div>
      <Header title="All Pages" subtitle="HTML pages across all client workspaces" />
      <div className="p-6">
        {pages.length === 0 ? (
          <EmptyState
            icon={FileCode2}
            title="No pages yet"
            description="Upload HTML pages from a client workspace."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {pages.map((page: Record<string, unknown>) => {
              const ws = page.workspaces as { name: string; client_id: string; clients: { name: string } } | null;
              return (
                <div key={page.id as string} className="card p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-9 h-9 rounded-lg bg-slate-700 flex items-center justify-center">
                      <FileCode2 size={15} className="text-indigo-400" />
                    </div>
                    <span className="text-slate-500 text-xs">{formatDate(page.created_at as string)}</span>
                  </div>
                  <h3 className="font-medium text-slate-200 truncate mb-0.5">{page.name as string}</h3>
                  {ws && (
                    <Link
                      href={`/clients/${ws.client_id}/pages`}
                      className="text-slate-500 text-xs hover:text-indigo-400 transition-colors"
                    >
                      {ws.clients?.name ?? ws.name}
                    </Link>
                  )}
                  {(page.tags as string[]).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {(page.tags as string[]).slice(0, 3).map((tag) => (
                        <span key={tag} className="flex items-center gap-1 badge bg-slate-700 text-slate-400 text-[10px]">
                          <Tag size={9} />
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
