import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import Header from '@/components/layout/Header';
import AIPagesClient from './AIPagesClient';

async function getWorkspaceForClient(clientId: string) {
  const { data } = await db
    .from('workspaces')
    .select('id, name')
    .eq('client_id', clientId)
    .single();
  return data;
}

export default async function AIPagesPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const wsRole = await resolveWorkspaceRole(workspace.id, session.user.id, session.user.role);
  if (!wsRole) notFound();

  const { data: client } = await db.from('clients').select('name, owner_id').eq('id', params.id).single();

  // Resolve owner plan — same logic as domains gate
  const ownerId = client?.owner_id ?? session.user.id;
  const { data: ownerRow } = await db.from('users').select('plan').eq('id', ownerId).single();
  const ownerPlan = ownerRow?.plan ?? 'free';
  const canUseAI = session.user.role === 'admin' || (PLAN_LIMITS[ownerPlan]?.aiPages ?? false);

  const { data: pages } = await db
    .from('pages')
    .select('id, name, vertical, is_published, published_url, html_url, created_at, updated_at, created_by, users(name)')
    .eq('workspace_id', workspace.id)
    .eq('source_type', 'ai_generated')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  // Look up which of these pages are already wired into a test as a live
  // variant, so the list can show an "Associated with..." badge and disable
  // the Save action for them (a page can only be linked into one test — see
  // /api/pages/[id]/save-as-variant).
  const pageIds = (pages ?? []).map((p) => p.id);
  const { data: linkedVariants } = pageIds.length
    ? await db
        .from('test_variants')
        .select('page_id, name, test_id, tests(name)')
        .in('page_id', pageIds)
    : { data: [] as { page_id: string; name: string; test_id: string; tests: { name: string } | { name: string }[] | null }[] };

  const linkedByPageId = new Map(
    (linkedVariants ?? []).map((lv) => {
      const testName = Array.isArray(lv.tests) ? lv.tests[0]?.name : lv.tests?.name;
      return [lv.page_id, { testId: lv.test_id, testName: testName ?? 'Test', variantName: lv.name }];
    })
  );

  const pagesWithLinks = (pages ?? []).map((p) => ({
    ...p,
    linked_variant: linkedByPageId.get(p.id) ?? null,
  }));

  return (
    <div>
      <Header title="AI Pages" subtitle={client?.name} />
      <div className="p-6">
        <AIPagesClient
          pages={pagesWithLinks}
          clientId={params.id}
          workspaceId={workspace.id}
          canManage={wsRole !== 'viewer'}
          canUseAI={canUseAI}
        />
      </div>
    </div>
  );
}
