import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { rawQuery } from '@/lib/db';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { Globe, CheckCircle, Clock, XCircle, Plus } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';

interface DomainRow {
  id: string;
  domain: string;
  verified: boolean;
  verified_at: string | null;
  created_at: string;
  workspace_id: string;
  client_id: string;
  client_name: string;
}

async function getAllDomains(userId: string): Promise<DomainRow[]> {
  const wsRows = await rawQuery<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_members WHERE user_id = $1`,
    [userId]
  );
  const userWorkspaceIds = wsRows.map(r => r.workspace_id);
  if (userWorkspaceIds.length === 0) return [];

  const { data: domains } = await db
    .from('domains')
    .select('id, domain, verified, verified_at, created_at, workspace_id, workspaces(client_id, clients(id, name))')
    .in('workspace_id', userWorkspaceIds)
    .order('created_at', { ascending: false }) as unknown as {
      data: Array<{
        id: string;
        domain: string;
        verified: boolean;
        verified_at: string | null;
        created_at: string;
        workspace_id: string;
        workspaces: { client_id: string; clients: { id: string; name: string } } | null;
      }> | null;
    };

  if (!domains) return [];

  return domains.map((d) => ({
    id: d.id,
    domain: d.domain,
    verified: d.verified,
    verified_at: d.verified_at,
    created_at: d.created_at,
    workspace_id: d.workspace_id,
    client_id: d.workspaces?.clients?.id ?? '',
    client_name: d.workspaces?.clients?.name ?? '',
  }));
}

export default async function AllDomainsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const domains = await getAllDomains(session.user.id);
  const verifiedCount = domains.filter((d) => d.verified).length;

  return (
    <div>
      <Header
        title="Domains"
        subtitle={`${domains.length} domain${domains.length !== 1 ? 's' : ''} across all client workspaces`}
      />
      <div className="p-6">
        {domains.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No domains configured"
            description="Add a custom domain inside a client workspace to route A/B test traffic through your own URL."
            action={
              <Link href="/clients" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] transition-colors shadow-sm">
                Add a Domain
              </Link>
            }
          />
        ) : (
          <>
            {/* Summary stats */}
            <div className="grid grid-cols-3 gap-4 mb-6 max-w-lg">
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">{domains.length}</p>
                <p className="text-xs text-slate-400 mt-0.5">Total</p>
              </div>
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold text-green-500 tabular-nums">{verifiedCount}</p>
                <p className="text-xs text-slate-400 mt-0.5">Verified</p>
              </div>
              <div className="card p-4 text-center">
                <p className="text-2xl font-bold text-amber-400 tabular-nums">{domains.length - verifiedCount}</p>
                <p className="text-xs text-slate-400 mt-0.5">Pending</p>
              </div>
            </div>

            <div className="space-y-3 max-w-3xl">
              {domains.map((d) => (
                <div key={d.id} className="card p-5 flex items-center gap-4 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Globe size={15} className={d.verified ? 'text-green-400' : 'text-slate-400'} />
                      <span className="font-medium text-slate-900 dark:text-slate-100">{d.domain}</span>
                      {d.verified ? (
                        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25">
                          <CheckCircle size={11} /> Verified
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">
                          <Clock size={11} /> Pending DNS
                        </span>
                      )}
                    </div>
                    {d.client_name && (
                      <p className="text-xs text-slate-400 dark:text-slate-500 ml-[23px]">
                        Client: {d.client_name}
                      </p>
                    )}
                  </div>
                  {d.client_id && (
                    <Link
                      href={`/clients/${d.client_id}/domains`}
                      className="btn-secondary text-xs whitespace-nowrap flex items-center gap-1.5"
                    >
                      {d.verified ? 'Manage' : (
                        <>
                          <XCircle size={12} className="text-amber-400" /> Configure DNS
                        </>
                      )}
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
