import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { loadPageSkills } from '@/lib/skills/persistence';
import { findActiveBuild, lastBuildError } from '@/lib/page-builds';
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
    .select('id, name, vertical, prompt, schema_json, conversation_json, html_url, html_content, slug, is_published, published_url, draft_html_content, draft_schema_json, source_type')
    .eq('id', searchParams.page_id)
    .eq('workspace_id', workspace.id)
    .single();

  if (!initialPage) notFound();

  // Own query, never throws — the skills/style columns arrive in migration 062
  // and folding them into the SELECT above would blank this whole editor page
  // on any environment that has not applied it yet.
  const savedSkillState = await loadPageSkills(initialPage.id);

  // A build still running for this page. The tab that started it may be long
  // gone — the build survives it now, so the screen has to be able to rejoin.
  // Stale rows are marked failed by this lookup rather than reported as live.
  const activeBuild = await findActiveBuild(initialPage.id);

  // Only meaningful when nothing is live: it is the reason the last attempt
  // ended, so the screen can say "ran out of time" instead of "didn't finish".
  const failedBuildMessage = activeBuild ? null : await lastBuildError(initialPage.id);

  // A build and an edit hold the same row but need opposite treatment: a build
  // is watched and replayed, an edit is only waited out. See BuildKind.
  const liveBuild = activeBuild?.kind === 'edit' ? null : activeBuild;
  const liveEdit = activeBuild?.kind === 'edit' ? activeBuild : null;

  // Pages reached via a test variant's "Edit using AI" button are already
  // live on that test the moment they're saved (served directly from this
  // same pages row) — Publish would just create an unrelated, unused
  // standalone URL, so the builder UI swaps it for a "Back to Test" action
  // instead. The generic AI Pages list is also the wrong "back" destination
  // for these pages — it's filtered to source_type='ai_generated' and will
  // always be empty for a variant's page, so send the user back to the test
  // they came from instead.
  const { data: linkedVariant } = await db
    .from('test_variants')
    .select('id, name, test_id, tests(name)')
    .eq('page_id', initialPage.id)
    .limit(1)
    .maybeSingle();

  const isTestVariantPage = !!linkedVariant;
  // Publishing a standalone URL and serving as a test variant are independent
  // concerns — only pages with no independent identity (raw HTML pasted
  // straight into a test's "Add Variant" flow, never touching the AI Pages
  // list) have nothing meaningful to publish.
  const canPublish = initialPage.source_type === 'ai_generated';
  const backPath = isTestVariantPage
    ? `/clients/${params.id}/tests/${linkedVariant.test_id}`
    : `/clients/${params.id}/ai-pages`;
  // Breadcrumb should read as "which test + variant am I editing", not the
  // client name, when reached via a test variant's "Edit using AI" button —
  // a test can have multiple variants, so the variant name alone isn't
  // enough to know which one this is.
  const linkedTestName = (linkedVariant?.tests as unknown as { name: string } | { name: string }[] | null) ?? null;
  const testName = Array.isArray(linkedTestName) ? linkedTestName[0]?.name : linkedTestName?.name;

  return (
    <AIBuilderClient
      // Force a full remount when navigating between page_ids on this same
      // route (e.g. redirecting into a page freshly forked via "Save as
      // New") — the component's hydration effect only runs once on mount,
      // so without this, stale state from the previous page would leak in.
      key={initialPage.id}
      workspaceId={workspace.id}
      clientId={params.id}
      clientName={isTestVariantPage && testName ? testName : (client?.name ?? 'Client')}
      variantName={isTestVariantPage ? linkedVariant.name : undefined}
      initialPage={initialPage}
      activeBuildId={liveBuild?.id ?? null}
      activeEditId={liveEdit?.id ?? null}
      failedBuildMessage={failedBuildMessage}
      initialSkills={savedSkillState.skills}
      initialStyle={savedSkillState.style}
      backPath={backPath}
      canUseAI={canUseAI}
      isTestVariantPage={isTestVariantPage}
      canPublish={canPublish}
    />
  );
}
