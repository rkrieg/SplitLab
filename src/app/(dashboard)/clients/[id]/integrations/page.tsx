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

  const { data: integrationRows } = await db
    .from('workspace_integrations')
    .select('id, type, config, enabled')
    .eq('workspace_id', workspace.id);
  const rows = integrationRows ?? [];

  const clarityRow = rows.find(r => r.type === 'clarity' && r.enabled);
  const clarityCfg = (clarityRow?.config ?? null) as { project_id?: string; api_token?: string } | null;

  const hubspotRow = rows.find(r => r.type === 'hubspot' && r.enabled);
  const hubspotConnected = !!(hubspotRow && (hubspotRow.config as { access_token?: string } | null)?.access_token);
  const hubspotHubId = (hubspotRow?.config as { hub_id?: number | string | null } | null)?.hub_id ?? null;

  const globalWebhooks = rows
    .filter(r => r.type === 'webhook' && r.enabled && (r.config as { global?: boolean } | null)?.global === true)
    .map(r => {
      const c = r.config as { url?: string; format?: string };
      return { id: r.id as string, url: c?.url ?? '', format: (c?.format ?? 'json') as 'json' | 'form' | 'xml' };
    });

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
          clientId={params.id}
          initialProjectId={clarityCfg?.project_id ?? null}
          initialToken={clarityCfg?.api_token ?? ''}
          hubspotConnected={hubspotConnected}
          hubspotHubId={hubspotHubId != null ? String(hubspotHubId) : null}
          initialGlobalWebhooks={globalWebhooks}
          canManage={wsRole === 'manager'}
        />
      </div>
    </div>
  );
}
