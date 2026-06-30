import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
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
    .select('name, owner_id')
    .eq('id', params.id)
    .single();

  // Resolve the workspace owner's plan — invited managers use the owner's plan, not their own
  const ownerId = client?.owner_id ?? session.user.id;
  const { data: ownerRow } = await db.from('users').select('plan').eq('id', ownerId).single();
  const ownerPlan = ownerRow?.plan ?? 'free';
  const canUseAI = session.user.role === 'admin' || (PLAN_LIMITS[ownerPlan]?.aiPages ?? false);

  if (!searchParams.page_id) redirect(`/clients/${params.id}/ai-pages`);

  const { data: initialPage } = await db
    .from('pages')
    .select('id, name, vertical, schema_json, conversation_json, html_url, html_content, slug, is_published, published_url')
    .eq('id', searchParams.page_id)
    .eq('workspace_id', workspace.id)
    .single();

  if (!initialPage) notFound();

  return (
    <AIBuilderClient
      workspaceId={workspace.id}
      clientId={params.id}
      clientName={client?.name ?? 'Client'}
      initialPage={initialPage}
      backPath={`/clients/${params.id}/ai-pages`}
      canUseAI={canUseAI}
    />
  );
}
