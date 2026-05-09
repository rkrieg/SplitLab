import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import WebhooksClient from './WebhooksClient';

export const dynamic = 'force-dynamic';

export default async function WebhooksPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: client } = await db
    .from('clients')
    .select('id, name')
    .eq('id', params.id)
    .single() as unknown as { data: { id: string; name: string } | null };
  if (!client) notFound();

  const { data: workspace } = await db
    .from('workspaces')
    .select('id, name')
    .eq('client_id', params.id)
    .single() as unknown as { data: { id: string; name: string } | null };
  if (!workspace) notFound();

  return (
    <div>
      <Header title="Webhooks" subtitle={client.name} />
      <WebhooksClient workspaceId={workspace.id} clientId={params.id} />
    </div>
  );
}
