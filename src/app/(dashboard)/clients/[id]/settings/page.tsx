import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { CNAME_TARGET, VERCEL_A_RECORD } from '@/lib/constants';
import Header from '@/components/layout/Header';
import ClientSettingsClient from './ClientSettingsClient';

async function getWorkspaceForClient(clientId: string) {
  const { data } = await db.from('workspaces').select('id, name').eq('client_id', clientId).single();
  return data;
}

export default async function ClientSettingsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: client } = await db.from('clients').select('*').eq('id', params.id).single();
  if (!client) notFound();

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const { data: domains } = await db
    .from('domains')
    .select('*')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(1);

  const appHostname = CNAME_TARGET;
  const appARecord = VERCEL_A_RECORD;

  return (
    <div>
      <Header title="Settings" subtitle={client.name} />
      <div className="p-6">
        <ClientSettingsClient
          client={client}
          initialDomains={domains ?? []}
          workspaceId={workspace.id}
          appHostname={appHostname}
          appARecord={appARecord}
          canManage={session.user.role !== 'viewer'}
        />
      </div>
    </div>
  );
}
