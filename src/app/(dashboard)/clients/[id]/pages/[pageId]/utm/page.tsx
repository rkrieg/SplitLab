import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import UTMPickerClient, { type StoredFieldSelectors } from '@/app/(dashboard)/clients/[id]/ai-pages/[pageId]/utm/UTMPickerClient';
import type { UTMRule, UTMCondition } from '@/app/(dashboard)/clients/[id]/ai-pages/[pageId]/utm/page';

interface PageProps {
  params: { id: string; pageId: string };
}

export default async function HtmlPageUTMPickerPage({ params }: PageProps) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: workspace } = await db
    .from('workspaces')
    .select('id')
    .eq('client_id', params.id)
    .single();

  if (!workspace) notFound();

  const wsRole = await resolveWorkspaceRole(workspace.id, session.user.id, session.user.role);
  if (!wsRole) notFound();
  if (wsRole === 'viewer') redirect(`/clients/${params.id}/pages`);

  const { data: page } = await db
    .from('pages')
    .select('id, name, slug, field_selectors_json, is_published, published_url')
    .eq('id', params.pageId)
    .eq('workspace_id', workspace.id)
    .single();

  if (!page) notFound();

  const { data: rules } = await db
    .from('personalization_rules')
    .select('*')
    .eq('page_id', params.pageId)
    .order('is_fallback', { ascending: true })
    .order('priority', { ascending: true });

  return (
    <UTMPickerClient
      clientId={params.id}
      page={{
        id: page.id,
        name: page.name,
        slug: page.slug,
        isAiPage: false,
        fieldSelectors: (page.field_selectors_json as StoredFieldSelectors | null) ?? {},
        isPublished: page.is_published,
        publishedUrl: page.published_url,
      }}
      initialRules={(rules ?? []).map(r => ({
        ...r,
        conditions: (r.conditions_json as UTMCondition[] | null) ?? undefined,
      })) as UTMRule[]}
    />
  );
}
