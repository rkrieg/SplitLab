import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { CNAME_TARGET, VERCEL_A_RECORD } from '@/lib/constants';
import { PLAN_LIMITS } from '@/lib/plans';
import Header from '@/components/layout/Header';
import ClientSettingsClient from './ClientSettingsClient';

async function getWorkspaceForClient(clientId: string) {
  const { data } = await db.from('workspaces').select('id, name').eq('client_id', clientId).single();
  return data;
}

export default async function ClientSettingsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: client } = await db.from('clients').select('*').eq('id', params.id).single();
  if (!client) notFound();

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const { data: domains } = await db
    .from('domains')
    .select('*')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(1);

  const appHostname = CNAME_TARGET;
  const appARecord = VERCEL_A_RECORD;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

  // Resolve domain limit for this user's plan.
  // Admins bypass limits; Infinity is passed as null (can't serialize Infinity as a prop).
  let domainLimit: number | null = null; // null = unlimited
  if (session.user.role !== 'admin') {
    const { data: userRow } = await db
      .from('users')
      .select('plan')
      .eq('id', session.user.id)
      .single();
    const plan = (userRow as { plan?: string } | null)?.plan ?? 'free';
    const limit = PLAN_LIMITS[plan]?.domains ?? 0;
    domainLimit = isFinite(limit) ? limit : null; // null = unlimited (Scale)
  }

  return (
    <div>
      <Header title="Settings" subtitle={client.name} />
      <div className="p-6">
        <ClientSettingsClient
          client={client}
          initialDomains={domains ?? []}
          workspaceId={workspace.id}
          appHostname={appHostname}
          appARecord={appARecord}
          appUrl={appUrl}
          canManage={session.user.role !== 'viewer'}
          domainLimit={domainLimit}
        />
      </div>
    </div>
  );
}
