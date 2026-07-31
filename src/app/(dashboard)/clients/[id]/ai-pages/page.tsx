import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { getLinkedVariant } from '@/lib/page-drafts';
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

  // Pages show up here either because they were made through "Create New"
  // (source_type='ai_generated'), or because they're a test variant's page
  // that's mid-edit in the AI builder (source_type='manual' with a pending
  // draft) — that draft has no relation to the test until the user explicitly
  // "Save as Variant"/"Save as New", so until then it's floating, unsaved
  // work that belongs in this list like any other in-progress AI page.
  const { data: rawPages } = await db
    .from('pages')
    .select('id, name, vertical, is_published, published_url, created_at, updated_at, created_by, users(name), source_type, draft_html_content')
    .eq('workspace_id', workspace.id)
    .or('source_type.eq.ai_generated,and(source_type.eq.manual,draft_html_content.not.is.null)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  const pages = await Promise.all(
    (rawPages ?? []).map(async (p) => {
      const isVariantDraft = p.source_type === 'manual' && !!p.draft_html_content;
      let variantName: string | null = null;
      let testName: string | null = null;
      if (isVariantDraft) {
        const linkedVariant = await getLinkedVariant(p.id);
        if (linkedVariant) {
          variantName = linkedVariant.name;
          const linkedTestName = linkedVariant.tests as unknown as { name: string } | { name: string }[] | null;
          testName = Array.isArray(linkedTestName) ? linkedTestName[0]?.name ?? null : linkedTestName?.name ?? null;
        }
      }
      // Never forward the raw draft HTML to the client — only the flags/names needed to render the ticker.
      return {
        id: p.id,
        name: p.name,
        vertical: p.vertical,
        is_published: p.is_published,
        published_url: p.published_url,
        created_at: p.created_at,
        updated_at: p.updated_at,
        users: p.users,
        is_variant_draft: isVariantDraft,
        variant_name: variantName,
        test_name: testName,
      };
    })
  );

  return (
    <div>
      <Header title="AI Pages" subtitle={client?.name} />
      <div className="p-6">
        <AIPagesClient
          pages={pages}
          clientId={params.id}
          workspaceId={workspace.id}
          canManage={wsRole !== 'viewer'}
          canUseAI={canUseAI}
        />
      </div>
    </div>
  );
}
