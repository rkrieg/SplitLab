import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import DomainsClient from './DomainsClient';

async function getWorkspaceForClient(clientId: string) {
  const { data } = await db.from('workspaces').select('id, name').eq('client_id', clientId).single();
  return data;
}

export default async function DomainsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const { data: domains } = await db
    .from('domains')
    .select('*')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false });

  const { data: client } = await db.from('clients').select('name').eq('id', params.id).single();

  const appHostname = process.env.APP_HOSTNAME || 'cname.vercel-dns.com';

  return (
    <div>
      <Header
        title="Domain Management"
        subtitle={client?.name}
        actions={
          <Link href={`/clients/${params.id}`} className="btn-secondary text-xs">
            <ArrowLeft size={14} /> Back
          </Link>
        }
      />
      <div className="p-6">
        <DomainsClient
          initialDomains={domains ?? []}
          workspaceId={workspace.id}
          appHostname={appHostname}
          canManage={session.user.role !== 'viewer'}
        />
      </div>
    </div>
  );
}
