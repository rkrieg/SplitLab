import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import PagesClient from './PagesClient';

async function getWorkspaceForClient(clientId: string) {
  const { data } = await db
    .from('workspaces')
    .select('id, name')
    .eq('client_id', clientId)
    .single();
  return data;
}

async function getTests(workspaceId: string) {
  const { data } = await db
    .from('tests')
    .select('*, test_variants(*), conversion_goals(*)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

async function getDomain(workspaceId: string) {
  const { data } = await db
    .from('domains')
    .select('domain, verified')
    .eq('workspace_id', workspaceId)
    .limit(1)
    .single();
  return data;
}

export default async function PagesPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const { data: client } = await db.from('clients').select('name').eq('id', params.id).single();
  const [tests, domain] = await Promise.all([
    getTests(workspace.id),
    getDomain(workspace.id),
  ]);

  return (
    <div>
      <Header title="Pages" subtitle={client?.name} />
      <div className="p-6">
        <PagesClient
          tests={tests}
          workspaceId={workspace.id}
          clientId={params.id}
          canManage={session.user.role !== 'viewer'}
          domain={domain?.verified ? domain.domain : undefined}
        />
      </div>
    </div>
  );
}
