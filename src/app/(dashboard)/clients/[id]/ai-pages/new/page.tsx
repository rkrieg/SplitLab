import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import AIBuilderClient from '../../pages/new/AIBuilderClient';

interface PageProps {
  params: { id: string };
  searchParams: { page_id?: string };
}

export default async function AIBuilderPage({ params, searchParams }: PageProps) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: workspace } = await db
    .from('workspaces')
    .select('id, name')
    .eq('client_id', params.id)
    .single();

  if (!workspace) notFound();

  const wsRole = await resolveWorkspaceRole(workspace.id, session.user.id, session.user.role);
  if (!wsRole) notFound();
  if (wsRole === 'viewer') redirect(`/clients/${params.id}/ai-pages`);

  const { data: client } = await db
    .from('clients')
    .select('name')
    .eq('id', params.id)
    .single();

  // Resume mode: load existing page
  let initialPage = null;
  if (searchParams.page_id) {
    const { data: page } = await db
      .from('pages')
      .select('id, name, vertical, schema_json, conversation_json, html_url, html_content, is_published, published_url')
      .eq('id', searchParams.page_id)
      .eq('workspace_id', workspace.id)
      .single();
    initialPage = page ?? null;
  }

  return (
    <AIBuilderClient
      workspaceId={workspace.id}
      clientId={params.id}
      clientName={client?.name ?? 'Client'}
      initialPage={initialPage}
      backPath={`/clients/${params.id}/ai-pages`}
    />
  );
}
