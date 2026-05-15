import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import DomainsClient from './DomainsClient';

async function getWorkspaceForClient(clientId: string): Promise<{ id: string } | null> {
  const { data } = await db.from('workspaces').select('id').eq('client_id', clientId).single() as unknown as { data: { id: string } | null };
  return data;
}

export default async function ClientDomainsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: client } = await db.from('clients').select('*').eq('id', params.id).single() as unknown as { data: { id: string; name: string; slug: string } | null };
  if (!client) notFound();

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const { data: domains } = await db
    .from('domains')
    .select('*')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false }) as unknown as { data: { id: string; domain: string; cname_target: string | null; verified: boolean; verified_at: string | null; created_at: string; fallback_url?: string | null }[] | null };

  const appHostname =
    process.env.CNAME_TARGET ||
    process.env.APP_HOSTNAME ||
    'split-lab.replit.app';

  return (
    <div>
      <Header title="Domains" subtitle={client.name} />
      <div className="p-6">
        <DomainsClient
          clientId={params.id}
          initialDomains={domains ?? []}
          workspaceId={workspace.id}
          appHostname={appHostname}
          canManage={session.user.role !== 'viewer'}
        />
      </div>
    </div>
  );
}
