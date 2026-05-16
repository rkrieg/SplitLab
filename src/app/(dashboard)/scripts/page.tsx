import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { rawQuery } from '@/lib/db';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { Code2 } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import { formatDate } from '@/lib/utils';

interface ScriptRow {
  id: string;
  name: string;
  type: string;
  placement: string;
  is_active: boolean;
  created_at: string;
  workspaces: { name: string; client_id: string; clients: { name: string } } | null;
}

async function getAllScripts(userId: string) {
  const wsRows = await rawQuery<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_members WHERE user_id = $1`,
    [userId]
  );
  const userWorkspaceIds = wsRows.map(r => r.workspace_id);
  if (userWorkspaceIds.length === 0) return [];

  const { data } = await (db
    .from('scripts')
    .select('*, workspaces(name, client_id, clients(name))')
    .in('workspace_id', userWorkspaceIds)
    .order('created_at', { ascending: false }) as unknown as Promise<{ data: ScriptRow[] | null }>);
  return data ?? [];
}

export default async function AllScriptsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const scripts = await getAllScripts(session.user.id);

  const typeLabel: Record<string, string> = {
    gtm: 'GTM', meta_pixel: 'Meta Pixel', ga4: 'GA4', custom: 'Custom',
  };

  return (
    <div>
      <Header title="All Scripts" subtitle="Tracking scripts across all client workspaces" />
      <div className="p-6">
        {scripts.length === 0 ? (
          <EmptyState
            icon={Code2}
            title="No scripts yet"
            description="Inject tracking scripts like GTM, Meta Pixel, or GA4 into your client workspaces."
            action={
              <Link href="/clients" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] transition-colors shadow-sm">
                Add a Script
              </Link>
            }
          />
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Name</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Client</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Type</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Placement</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Status</th>
                  <th className="text-left px-5 py-3 text-slate-400 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {scripts.map((script) => {
                  const ws = script.workspaces;
                  return (
                    <tr key={script.id} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                      <td className="px-5 py-3.5 font-medium text-slate-200">{script.name}</td>
                      <td className="px-5 py-3.5">
                        {ws && (
                          <Link href={`/clients/${ws.client_id}/scripts`} className="text-slate-400 hover:text-indigo-400 text-xs">
                            {ws.clients?.name ?? ws.name}
                          </Link>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="badge bg-slate-700 text-slate-300">{typeLabel[script.type] ?? script.type}</span>
                      </td>
                      <td className="px-5 py-3.5 text-slate-400 font-mono text-xs">{script.placement === 'head' ? '<head>' : '</body>'}</td>
                      <td className="px-5 py-3.5">
                        <span className={`badge ${script.is_active ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-slate-700 text-slate-400'}`}>
                          {script.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-slate-400">{formatDate(script.created_at)}</td>
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
