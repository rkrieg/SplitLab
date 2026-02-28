import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import ScriptsClient from './ScriptsClient';

async function getWorkspaceForClient(clientId: string) {
  const { data } = await db.from('workspaces').select('id, name').eq('client_id', clientId).single();
  return data;
}

export default async function ScriptsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const { data: scripts } = await db
    .from('scripts')
    .select('*, pages(id, name)')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false });

  const { data: pages } = await db
    .from('pages')
    .select('id, name')
    .eq('workspace_id', workspace.id)
    .eq('status', 'active');

  const { data: client } = await db.from('clients').select('name').eq('id', params.id).single();

  return (
    <div>
      <Header
        title="Script Injection Manager"
        subtitle={client?.name}
        actions={
          <Link href={`/clients/${params.id}`} className="btn-secondary text-xs">
            <ArrowLeft size={14} /> Back
          </Link>
        }
      />
      <div className="p-6">
        <ScriptsClient
          initialScripts={scripts ?? []}
          pages={pages ?? []}
          workspaceId={workspace.id}
          canManage={session.user.role !== 'viewer'}
        />
      </div>
    </div>
  );
}
