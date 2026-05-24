import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { CNAME_TARGET, VERCEL_A_RECORD } from '@/lib/constants';
import Header from '@/components/layout/Header';
import DomainsClient from './DomainsClient';

export default async function ClientDomainsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: client } = await db.from('clients').select('id, name, slug').eq('id', params.id).single();
  if (!client) notFound();

  const { data: workspace } = await db.from('workspaces').select('id').eq('client_id', params.id).single();
  if (!workspace) notFound();

  const { data: domains } = await db
    .from('domains')
    .select('*')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false });

  return (
    <div>
      <Header title="Domains" subtitle={client.name} />
      <div className="p-6">
        <DomainsClient
          initialDomains={domains ?? []}
          workspaceId={workspace.id}
          appHostname={CNAME_TARGET}
          appARecord={VERCEL_A_RECORD}
          canManage={session.user.role !== 'viewer'}
        />
      </div>
    </div>
  );
}
