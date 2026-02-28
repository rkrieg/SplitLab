import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import PagesClient from './PagesClient';

async function getWorkspaceForClient(clientId: string) {
  const { data } = await db
    .from('workspaces')
    .select('id, name')
    .eq('client_id', clientId)
    .single();
  return data;
}

async function getPages(workspaceId: string) {
  const { data } = await db
    .from('pages')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

export default async function PagesPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const pages = await getPages(workspace.id);

  const { data: client } = await db.from('clients').select('name').eq('id', params.id).single();

  return (
    <div>
      <Header
        title="Page Library"
        subtitle={client?.name}
        actions={
          <Link href={`/clients/${params.id}`} className="btn-secondary text-xs">
            <ArrowLeft size={14} /> Back
          </Link>
        }
      />
      <div className="p-6">
        <PagesClient
          initialPages={pages}
          workspaceId={workspace.id}
          canManage={session.user.role !== 'viewer'}
        />
      </div>
    </div>
  );
}
