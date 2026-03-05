import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { FileCode2 } from 'lucide-react';
import { TestStatusBadge } from '@/components/ui/Badge';
import EmptyState from '@/components/ui/EmptyState';

async function getAllTests() {
  const { data } = await db
    .from('tests')
    .select(`
      id, name, url_path, status, created_at,
      workspaces ( name, client_id, clients ( name ) ),
      test_variants ( id )
    `)
    .order('created_at', { ascending: false });
  return data ?? [];
}

export default async function AllPagesPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const tests = await getAllTests();

  return (
    <div>
      <Header title="All Pages" subtitle="Pages across all client workspaces" />
      <div className="p-6">
        {tests.length === 0 ? (
          <EmptyState
            icon={FileCode2}
            title="No pages yet"
            description="Pages will appear here once created in a client workspace."
          />
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Page</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Client</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">URL Path</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Variants</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Status</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Analytics</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((test: Record<string, unknown>) => {
                  const ws = test.workspaces as { name: string; client_id: string; clients: { name: string } } | null;
                  const variants = test.test_variants as { id: string }[] | null;
                  return (
                    <tr key={test.id as string} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                      <td className="px-5 py-3.5 font-medium text-slate-200">{test.name as string}</td>
                      <td className="px-5 py-3.5 text-slate-400">
                        {ws?.client_id ? (
                          <Link href={`/clients/${ws.client_id}/pages`} className="hover:text-indigo-400 transition-colors">
                            {ws.clients?.name ?? '—'}
                          </Link>
                        ) : '—'}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-slate-400">{test.url_path as string}</td>
                      <td className="px-5 py-3.5 text-slate-400">{variants?.length ?? 0}</td>
                      <td className="px-5 py-3.5"><TestStatusBadge status={test.status as string} /></td>
                      <td className="px-5 py-3.5">
                        {ws?.client_id && (
                          <Link
                            href={`/clients/${ws.client_id}/tests/${test.id}`}
                            className="text-indigo-400 hover:text-indigo-300 text-xs"
                          >
                            View →
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
