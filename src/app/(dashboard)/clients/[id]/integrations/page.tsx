import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import IntegrationsClient from './IntegrationsClient';

export default async function IntegrationsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: workspace } = await db.from('workspaces').select('id, name').eq('client_id', params.id).single();
  if (!workspace) notFound();

  const wsRole = await resolveWorkspaceRole(workspace.id, session.user.id, session.user.role);
  if (!wsRole) notFound();

  const { data: clarityRows } = await db
    .from('workspace_integrations')
    .select('config, enabled')
    .eq('workspace_id', workspace.id)
    .eq('type', 'clarity')
    .limit(1);
  const clarityCfg = (clarityRows?.[0]?.enabled ? clarityRows[0].config : null) as { project_id?: string; api_token?: string } | null;

  const { data: client } = await db.from('clients').select('name').eq('id', params.id).single();

  return (
    <div>
      <Header
        title="Integrations"
        subtitle={client?.name}
        actions={
          <Link href={`/clients/${params.id}`} className="btn-secondary text-xs">
            <ArrowLeft size={14} /> Back
          </Link>
        }
      />
      <div className="p-6">
        <IntegrationsClient
          workspaceId={workspace.id}
          initialProjectId={clarityCfg?.project_id ?? null}
          initialToken={clarityCfg?.api_token ?? ''}
          canManage={wsRole === 'manager'}
        />
      </div>
    </div>
  );
}
