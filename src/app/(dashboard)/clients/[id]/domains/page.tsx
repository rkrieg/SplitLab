import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { CNAME_TARGET, VERCEL_A_RECORD } from '@/lib/constants';
import { PLAN_LIMITS } from '@/lib/plans';
import Header from '@/components/layout/Header';
import DomainsClient from './DomainsClient';

export default async function ClientDomainsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: client } = await db.from('clients').select('id, name, slug, owner_id').eq('id', params.id).single();
  if (!client) notFound();

  const { data: workspace } = await db.from('workspaces').select('id').eq('client_id', params.id).single();
  if (!workspace) notFound();

  const wsRole = await resolveWorkspaceRole(workspace.id, session.user.id, session.user.role);
  if (!wsRole) notFound();

  const { data: domains } = await db
    .from('domains')
    .select('*')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false });

  // Domain limit is based on the account OWNER's plan, not the invited user's plan
  const ownerId = client.owner_id ?? session.user.id;
  const { data: ownerRow } = await db.from('users').select('plan').eq('id', ownerId).single();
  const ownerPlan = ownerRow?.plan ?? 'free';
  const canAddDomain = session.user.role === 'admin' || (PLAN_LIMITS[ownerPlan]?.domains ?? 0) > 0;

  return (
    <div>
      <Header title="Domains" subtitle={client.name} />
      <div className="p-6">
        <DomainsClient
          initialDomains={domains ?? []}
          workspaceId={workspace.id}
          appHostname={CNAME_TARGET}
          appARecord={VERCEL_A_RECORD}
          canManage={wsRole === 'manager'}
          canAddDomain={canAddDomain}
        />
      </div>
    </div>
  );
}
