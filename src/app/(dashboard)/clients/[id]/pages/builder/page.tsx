import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import PageBuilderClient from './PageBuilderClient';

export default async function PageBuilderPage({
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

  return (
    <div>
      <Header
        title="AI Page Builder"
        subtitle={client?.name}
      />
      <div className="p-6">
        <PageBuilderClient
          workspaceId={workspace.id}
          clientId={params.id}
        />
      </div>
    </div>
  );
}
