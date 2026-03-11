import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import AIGenerateClient from './AIGenerateClient';

export default async function AIGeneratePage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');
  if (session.user.role === 'viewer') redirect(`/clients/${params.id}/pages`);

  const { data: workspace } = await db
    .from('workspaces')
    .select('id, name')
    .eq('client_id', params.id)
    .single();
  if (!workspace) notFound();

  const { data: client } = await db
    .from('clients')
    .select('name')
    .eq('id', params.id)
    .single();

  // Get domain for the workspace
  const { data: domainData } = await db
    .from('domains')
    .select('domain, verified')
    .eq('workspace_id', workspace.id)
    .eq('verified', true)
    .limit(1)
    .single();

  return (
    <div>
      <Header
        title="Generate Variants with AI"
        subtitle={client?.name}
      />
      <div className="p-6">
        <AIGenerateClient
          workspaceId={workspace.id}
          clientId={params.id}
          domain={domainData?.domain}
        />
      </div>
    </div>
  );
}
