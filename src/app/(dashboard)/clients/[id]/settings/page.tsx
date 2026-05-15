import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import ClientSettingsClient from './ClientSettingsClient';

async function getWorkspaceForClient(clientId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await db.from('workspaces').select('id, name').eq('client_id', clientId).single() as unknown as { data: { id: string; name: string } | null };
  return data;
}

export default async function ClientSettingsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: client } = await db.from('clients').select('*').eq('id', params.id).single() as unknown as { data: { id: string; name: string; slug: string } | null };
  if (!client) notFound();

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const { data: members } = await (db
    .from('workspace_members')
    .select('id, role, user_id, users(id, name, email, role)')
    .eq('workspace_id', workspace.id) as unknown as Promise<{ data: { id: string; role: string; user_id: string; users: { id: string; name: string; email: string; role: string } | null }[] | null }>);

  return (
    <div>
      <Header title="Settings" subtitle={client.name} />
      <div className="p-6">
        <ClientSettingsClient
          client={client}
          workspaceId={workspace.id}
          canManage={session.user.role !== 'viewer'}
          currentUserId={session.user.id}
          initialMembers={members ?? []}
        />
      </div>
    </div>
  );
}
