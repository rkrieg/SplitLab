import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import AIBuilderClient from './AIBuilderClient';

export default async function AIGeneratePage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: workspace } = await db
    .from('workspaces')
    .select('id, name')
    .eq('client_id', params.id)
    .single();

  if (!workspace) notFound();

  const wsRole = await resolveWorkspaceRole(workspace.id, session.user.id, session.user.role);
  if (!wsRole) notFound();
  if (wsRole === 'viewer') redirect(`/clients/${params.id}/pages`);

  const { data: client } = await db
    .from('clients')
    .select('name')
    .eq('id', params.id)
    .single();

  return (
    <AIBuilderClient
      workspaceId={workspace.id}
      clientId={params.id}
      clientName={client?.name ?? 'Client'}
    />
  );
}
