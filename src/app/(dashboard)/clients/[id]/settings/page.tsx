import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import Header from '@/components/layout/Header';
import ClientSettingsClient from './ClientSettingsClient';

export default async function ClientSettingsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: client } = await db.from('clients').select('*').eq('id', params.id).single();
  if (!client) notFound();

  const { data: workspace } = await db.from('workspaces').select('id').eq('client_id', params.id).single();
  if (!workspace) notFound();

  const wsRole = await resolveWorkspaceRole(workspace.id, session.user.id, session.user.role);
  if (!wsRole) notFound();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

  return (
    <div>
      <Header title="Settings" subtitle={client.name} />
      <div className="p-6">
        <ClientSettingsClient
          client={client}
          appUrl={appUrl}
          canManage={wsRole === 'manager'}
          user={{ id: session.user.id, name: session.user.name, email: session.user.email, role: session.user.role }}
        />
      </div>
    </div>
  );
}
