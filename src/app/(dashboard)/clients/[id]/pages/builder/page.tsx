import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import PageBuilderClient from './PageBuilderClient';

interface InitialPage {
  id: string;
  name: string;
  status: string;
  html_content: string | null;
  quality_score: number | null;
  published_url: string | null;
}

export default async function PageBuilderPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { pageId?: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');
  if (session.user.role === 'viewer') redirect(`/clients/${params.id}/pages`);

  const { data: workspace } = await db
    .from('workspaces')
    .select('id, name')
    .eq('client_id', params.id)
    .single() as unknown as { data: { id: string; name: string } | null };
  if (!workspace) notFound();

  const { data: client } = await db
    .from('clients')
    .select('name')
    .eq('id', params.id)
    .single() as unknown as { data: { name: string } | null };

  let initialPage: InitialPage | null = null;
  if (searchParams.pageId) {
    const { data: page } = await db
      .from('pages')
      .select('id, name, status, html_content, quality_score, published_url')
      .eq('id', searchParams.pageId)
      .eq('workspace_id', workspace.id)
      .single() as unknown as { data: InitialPage | null };
    initialPage = page ?? null;
  }

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
          initialPage={initialPage}
        />
      </div>
    </div>
  );
}
