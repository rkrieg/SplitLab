import { db } from '@/lib/supabase-server';
import { takeOwnershipOfHtmlAssets } from '@/lib/ai-asset-integrity';
import { PLAN_LIMITS } from '@/lib/plans';
import { uploadHtml, downloadHtml, inlineDataUrisToStorage } from '@/lib/storage';
import { confidencePercent, findWinner } from '@/lib/stats';
import { getLinkedVariant } from '@/lib/page-drafts';
import { rescanVariantHtml } from './scan';
import { ok, fail, ServiceResult } from './types';

export function fullTestSelect() {
  return '*, test_variants(*, pages(id, name)), conversion_goals(*)';
}

/**
 * Trimmed test list for a workspace — id/name/status/variant summaries/goal
 * ids, everything the MCP list_tests tool needs without the full page-HTML
 * payload get_test/fullTestSelect would carry. Variant/goal ids are included
 * deliberately: get_test's own callers (update_test_weights, update_test_goals)
 * need them to echo back rather than regenerate.
 */
export async function listWorkspaceTests(workspaceId: string): Promise<ServiceResult<unknown[]>> {
  const { data, error } = await db
    .from('tests')
    .select('id, name, url_path, status, created_at, updated_at, test_variants(id, name, traffic_weight, is_control, archived_at, page_id), conversion_goals(id, name, type, is_primary)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (error) return fail(500, error.message);
  return ok(data ?? []);
}

/** Single test, full detail — same shape updateTest/duplicateVariant already return. */
export async function getTestDetail(testId: string): Promise<ServiceResult<unknown>> {
  const { data, error } = await db.from('tests').select(fullTestSelect()).eq('id', testId).single();
  if (error || !data) return fail(404, 'Not found');
  return ok(data);
}

/** Redistribute weights equally across a test's non-archived variants (sums to 100). */
export async function redistributeActiveWeights(testId: string) {
  const { data: active } = await db
    .from('test_variants')
    .select('id')
    .eq('test_id', testId)
    .is('archived_at', null)
    .order('created_at', { ascending: true });
  if (!active || active.length === 0) return;
  const equalWeight = Math.floor(100 / active.length);
  let remainder = 100 - equalWeight * active.length;
  for (const v of active) {
    const w = equalWeight + (remainder-- > 0 ? 1 : 0);
    await db.from('test_variants').update({ traffic_weight: w }).eq('id', v.id);
  }
}

export interface GoalInput {
  id?: string;
  name: string;
  type: 'form_submit' | 'button_click' | 'url_reached' | 'call_click';
  selector?: string | null;
  url_pattern?: string | null;
  is_primary: boolean;
  variant_id?: string | null;
}
export interface WeightInput { id: string; traffic_weight: number }
export interface VariantUpdateInput { id: string; name?: string; redirect_url?: string | null; proxy_mode?: boolean }
export interface UpdateTestInput {
  name?: string;
  url_path?: string;
  status?: 'draft' | 'active' | 'paused' | 'completed';
  head_scripts?: string | null;
  goals?: GoalInput[];
  weights?: WeightInput[];
  variant_updates?: VariantUpdateInput[];
  delete_variant_id?: string;
  archive_variant_id?: string;
  unarchive_variant_id?: string;
}
export interface TestMeta { workspace_id: string; url_path: string; status: string }

/**
 * All PATCH /api/tests/[id] sub-operations, extracted verbatim so the HTTP
 * route and MCP tools call the exact same guarded logic — a skipped guard
 * becomes a compile-time signature mismatch, not a runtime maybe.
 * Caller must already have resolved workspace role and rejected viewers.
 */
export async function updateTest(
  testId: string,
  testMeta: TestMeta,
  input: UpdateTestInput
): Promise<ServiceResult<unknown>> {
  const { goals, weights, variant_updates, delete_variant_id, archive_variant_id, unarchive_variant_id, ...testFields } = input;

  // Block duplicate active url_path within the same workspace when this update
  // would result in an active test (activation or path change while active)
  const nextStatus = testFields.status ?? testMeta.status;
  const nextPath = testFields.url_path ?? testMeta.url_path;
  if (nextStatus === 'active' && (testFields.status !== undefined || testFields.url_path !== undefined)) {
    const { data: pathConflict } = await db
      .from('tests')
      .select('id, name')
      .eq('workspace_id', testMeta.workspace_id)
      .eq('url_path', nextPath)
      .eq('status', 'active')
      .neq('id', testId)
      .limit(1)
      .maybeSingle();

    if (pathConflict) {
      return fail(409, `Another active test "${pathConflict.name}" is already running on path "${nextPath}". Pause it first.`);
    }
  }

  // Update test fields if any provided
  if (Object.keys(testFields).length > 0) {
    const { error } = await db.from('tests').update(testFields).eq('id', testId);
    if (error) return fail(500, error.message);
  }

  // Update variant weights if provided
  if (weights) {
    const totalWeight = weights.reduce((s, w) => s + w.traffic_weight, 0);
    if (totalWeight !== 100) {
      return fail(400, 'Weights must sum to 100');
    }
    for (const w of weights) {
      const { error: wErr } = await db
        .from('test_variants')
        .update({ traffic_weight: w.traffic_weight })
        .eq('id', w.id)
        .eq('test_id', testId);
      if (wErr) return fail(500, wErr.message);
    }
  }

  // Update variant fields (name, redirect_url, proxy_mode) if provided
  if (variant_updates) {
    const variantIds = variant_updates.map((vu) => vu.id);
    const { data: currentVariants } = await db
      .from('test_variants')
      .select('id, redirect_url')
      .in('id', variantIds)
      .eq('test_id', testId);
    const currentUrlMap = new Map((currentVariants ?? []).map((v) => [v.id, v.redirect_url]));

    const urlChangedIds: string[] = [];

    for (const vu of variant_updates) {
      const updateFields: Record<string, unknown> = {};
      if (vu.name !== undefined) updateFields.name = vu.name;
      if (vu.redirect_url !== undefined) updateFields.redirect_url = vu.redirect_url;
      if (vu.proxy_mode !== undefined) updateFields.proxy_mode = vu.proxy_mode;
      if (Object.keys(updateFields).length > 0) {
        const { error: vuErr } = await db
          .from('test_variants')
          .update(updateFields)
          .eq('id', vu.id)
          .eq('test_id', testId);
        if (vuErr) return fail(500, vuErr.message);
      }

      if (
        vu.redirect_url !== undefined &&
        (vu.redirect_url ?? '') !== (currentUrlMap.get(vu.id) ?? '')
      ) {
        urlChangedIds.push(vu.id);
      }
    }

    if (urlChangedIds.length > 0) {
      const { data: testRow } = await db.from('tests').select('scan_results').eq('id', testId).single();
      const existingScans = testRow?.scan_results as { variants?: { variant_id: string }[] } | null;
      if (existingScans?.variants?.some((v) => urlChangedIds.includes(v.variant_id))) {
        const pruned = { variants: existingScans.variants.filter((v) => !urlChangedIds.includes(v.variant_id)) };
        await db.from('tests').update({ scan_results: pruned }).eq('id', testId);
      }
    }
  }

  // Delete variant if requested
  if (delete_variant_id) {
    const { data: allVariants } = await db
      .from('test_variants')
      .select('id, page_id')
      .eq('test_id', testId);

    if (!allVariants || allVariants.length <= 1) {
      return fail(400, 'Cannot delete the last variant');
    }

    const target = allVariants.find((v) => v.id === delete_variant_id);
    if (!target) return fail(404, 'Variant not found');

    if (target.page_id) {
      const pageStillUsed = allVariants.some(
        (v) => v.id !== delete_variant_id && v.page_id === target.page_id,
      );
      if (!pageStillUsed) {
        await db.from('pages').update({ deleted_at: new Date().toISOString() }).eq('id', target.page_id).is('deleted_at', null);
      }
    }

    const { error: delErr } = await db.from('test_variants').delete().eq('id', delete_variant_id).eq('test_id', testId);
    if (delErr) return fail(500, delErr.message);

    const { data: testRow } = await db.from('tests').select('scan_results').eq('id', testId).single();
    const existingScans = testRow?.scan_results as { variants?: { variant_id: string }[] } | null;
    if (existingScans?.variants?.some((v) => v.variant_id === delete_variant_id)) {
      const pruned = { variants: existingScans.variants.filter((v) => v.variant_id !== delete_variant_id) };
      await db.from('tests').update({ scan_results: pruned }).eq('id', testId);
    }

    const { data: remaining } = await db
      .from('test_variants')
      .select('id')
      .eq('test_id', testId)
      .order('created_at', { ascending: true });

    if (remaining && remaining.length > 0) {
      const equalWeight = Math.floor(100 / remaining.length);
      let remainder = 100 - equalWeight * remaining.length;
      for (const v of remaining) {
        const w = equalWeight + (remainder-- > 0 ? 1 : 0);
        await db.from('test_variants').update({ traffic_weight: w }).eq('id', v.id);
      }
    }
  }

  // Archive a variant: pull it out of the live split (weight 0) but keep its
  // history. A test must always keep at least one active variant.
  if (archive_variant_id) {
    const { data: activeVariants } = await db
      .from('test_variants')
      .select('id')
      .eq('test_id', testId)
      .is('archived_at', null);

    const remainingActive = (activeVariants ?? []).filter((v) => v.id !== archive_variant_id).length;
    if (remainingActive === 0) {
      return fail(400, 'Cannot archive the last active variant — a test must always have at least one live.');
    }

    const { error } = await db
      .from('test_variants')
      .update({ archived_at: new Date().toISOString(), traffic_weight: 0 })
      .eq('id', archive_variant_id)
      .eq('test_id', testId);
    if (error) return fail(500, error.message);
    await redistributeActiveWeights(testId);
  }

  // Restore an archived variant back into the active split.
  if (unarchive_variant_id) {
    const { error } = await db
      .from('test_variants')
      .update({ archived_at: null })
      .eq('id', unarchive_variant_id)
      .eq('test_id', testId);
    if (error) return fail(500, error.message);
    await redistributeActiveWeights(testId);
  }

  // Upsert goals — preserve existing UUIDs so historical events stay linked
  if (goals) {
    const incomingIds = goals.filter((g) => g.id).map((g) => g.id as string);

    if (incomingIds.length > 0) {
      await db.from('conversion_goals')
        .delete()
        .eq('test_id', testId)
        .not('id', 'in', `(${incomingIds.map((id) => `"${id}"`).join(',')})`);
    } else {
      await db.from('conversion_goals').delete().eq('test_id', testId);
    }

    for (const g of goals) {
      if (g.id) {
        const { error: uErr } = await db.from('conversion_goals')
          .update({ name: g.name, type: g.type, selector: g.selector || null, url_pattern: g.url_pattern || null, is_primary: g.is_primary, variant_id: g.variant_id ?? null })
          .eq('id', g.id)
          .eq('test_id', testId);
        if (uErr) return fail(500, uErr.message);
      } else {
        const { error: iErr } = await db.from('conversion_goals')
          .insert({ test_id: testId, name: g.name, type: g.type, selector: g.selector || null, url_pattern: g.url_pattern || null, is_primary: g.is_primary, variant_id: g.variant_id ?? null });
        if (iErr) return fail(500, iErr.message);
      }
    }
  }

  const { data: updated, error: fetchError } = await db
    .from('tests')
    .select(fullTestSelect())
    .eq('id', testId)
    .single();

  if (fetchError) return fail(500, fetchError.message);
  return ok(updated);
}

/**
 * Clones a variant (HTML, Redirect, or Proxy mode) into a new variant on the
 * same test. Starts at 0% traffic and is never control — an active test's
 * live split isn't disturbed by adding a copy meant to be tweaked before it
 * goes live. Intentionally NOT copied: personalization_rules, conversion_goals
 * (a copied HTML variant gets a brand-new page row — a page can only ever
 * back one variant).
 */
export async function duplicateVariant(
  testId: string,
  variantId: string,
  workspaceId: string,
  userRole: string
): Promise<ServiceResult<unknown>> {
  const { data: source, error: sourceErr } = await db
    .from('test_variants')
    .select('id, name, page_id, redirect_url, proxy_mode, pages(html_content, html_url)')
    .eq('id', variantId)
    .eq('test_id', testId)
    .single();

  if (sourceErr || !source) return fail(404, 'Variant not found');

  if (userRole !== 'admin') {
    const { data: wsData } = await db.from('workspaces').select('client_id').eq('id', workspaceId).single();
    let planOwnerId: string | null = null;
    if (wsData) {
      const { data: clientData } = await db.from('clients').select('owner_id').eq('id', wsData.client_id).single();
      planOwnerId = clientData?.owner_id ?? null;
    }
    if (planOwnerId) {
      const { data: userRow } = await db.from('users').select('plan').eq('id', planOwnerId).single();
      const plan = userRow?.plan ?? 'free';
      const limit = PLAN_LIMITS[plan]?.variants ?? 2;

      if (isFinite(limit)) {
        const { count } = await db
          .from('test_variants')
          .select('*', { count: 'exact', head: true })
          .eq('test_id', testId);

        if ((count ?? 0) >= limit) {
          return fail(403, `Your plan allows a maximum of ${limit} variants per test. Please upgrade for unlimited variants.`, { limitError: true });
        }
      }
    }
  }

  const newName = `${source.name} copy`.slice(0, 255);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourcePages = source.pages as any;
  const sourcePage = Array.isArray(sourcePages) ? sourcePages[0] : sourcePages;

  let newPageId: string | null = null;
  let duplicatedHtml: string | null = null;

  if (source.page_id) {
    let sourceHtml: string | null = sourcePage?.html_content ?? null;
    if (!sourceHtml && sourcePage?.html_url) {
      try {
        sourceHtml = await downloadHtml(sourcePage.html_url);
      } catch {
        sourceHtml = null;
      }
    }
    if (!sourceHtml) return fail(400, 'This variant has no HTML content to duplicate');
    duplicatedHtml = sourceHtml;

    const fileName = `${workspaceId}/${crypto.randomUUID()}.html`;
    const htmlUrl = await uploadHtml(fileName, sourceHtml);

    const { data: newPage, error: pageErr } = await db
      .from('pages')
      .insert({
        workspace_id: workspaceId,
        name: newName,
        html_url: htmlUrl,
        html_content: sourceHtml.length < 500_000 ? sourceHtml : null,
      })
      .select('id')
      .single();

    if (pageErr) return fail(500, pageErr.message);
    newPageId = newPage.id;
  }

  const { data: newVariant, error: varErr } = await db
    .from('test_variants')
    .insert({
      test_id: testId,
      name: newName,
      page_id: newPageId,
      redirect_url: newPageId ? null : source.redirect_url,
      proxy_mode: newPageId ? false : source.proxy_mode,
      traffic_weight: 0,
      is_control: false,
      tracking_verified: null,
      duplicated_from_id: source.id,
    })
    .select('id')
    .single();

  if (varErr) return fail(500, varErr.message);

  // Regenerate from the actual duplicated HTML rather than copying the
  // source variant's old scan — the two pages are separate rows from this
  // point on and can drift independently.
  if (duplicatedHtml) {
    await rescanVariantHtml(testId, newVariant.id, newName, duplicatedHtml);
  }

  const { data: fullTest, error: fetchErr } = await db
    .from('tests')
    .select('*, test_variants(*, pages(id, name, draft_html_content)), conversion_goals(*)')
    .eq('id', testId)
    .single();

  if (fetchErr) return fail(500, fetchErr.message);
  return ok(fullTest);
}

/**
 * Duplicates a whole test: a fresh test on a new path with a copy of every
 * variant and conversion goal. Created as draft so it doesn't serve until
 * reviewed and activated.
 */
export interface CreateTestVariantInput {
  name: string;
  page_id?: string | null;
  redirect_url?: string | null;
  proxy_mode?: boolean;
  traffic_weight: number;
  is_control?: boolean;
}

export interface CreateTestGoalInput {
  name: string;
  type: 'form_submit' | 'button_click' | 'url_reached' | 'call_click';
  selector?: string | null;
  url_pattern?: string | null;
  is_primary?: boolean;
}

export interface CreateTestInput {
  workspace_id: string;
  name: string;
  url_path: string;
  status?: 'draft' | 'active';
  variants: CreateTestVariantInput[];
  goals?: CreateTestGoalInput[];
}

/**
 * Extracted verbatim from POST /api/workspaces/[id]/tests — the "Save as a
 * New Test" dashboard action and MCP's create_test tool both call this now.
 * Same guards as the original route: a page already linked to a test can't
 * be reused (would let an edit meant for one test silently change what
 * another is serving), plan test/variant-count limits traced to the
 * workspace owner's plan (not the caller's own, since an invited manager's
 * own row is always plan:'free'), weights must sum to exactly 100, and no
 * two active tests may share a url_path in the same workspace.
 */
export async function createTest(input: CreateTestInput, actorId: string, actorRole: string): Promise<ServiceResult<unknown>> {
  for (const v of input.variants) {
    if (v.page_id && await getLinkedVariant(v.page_id)) {
      return fail(400, 'This page is already associated with a test.');
    }
  }

  if (actorRole !== 'admin') {
    const { data: wsData } = await db.from('workspaces').select('client_id').eq('id', input.workspace_id).single();
    let planOwnerId = actorId;
    if (wsData) {
      const { data: clientData } = await db.from('clients').select('owner_id').eq('id', wsData.client_id).single();
      if (clientData?.owner_id) planOwnerId = clientData.owner_id;
    }

    const { data: userRow } = await db.from('users').select('plan').eq('id', planOwnerId).single();
    const plan = userRow?.plan ?? 'free';

    const testLimit = PLAN_LIMITS[plan]?.tests ?? 1;
    if (isFinite(testLimit)) {
      const { count: testCount } = await db
        .from('tests')
        .select('id, workspaces!inner(client_id, clients!inner(owner_id))', { count: 'exact', head: true })
        .eq('workspaces.clients.owner_id', planOwnerId)
        .not('status', 'eq', 'completed');

      if ((testCount ?? 0) >= testLimit) {
        return fail(403, `You have reached the test limit for your plan (${testLimit}). Please upgrade to create more tests.`, { limitError: true });
      }
    }

    const variantLimit = PLAN_LIMITS[plan]?.variants ?? 2;
    if (isFinite(variantLimit) && input.variants.length > variantLimit) {
      return fail(403, `Your plan allows a maximum of ${variantLimit} variants per test. Please upgrade for unlimited variants.`, { limitError: true });
    }
  }

  const totalWeight = input.variants.reduce((s, v) => s + v.traffic_weight, 0);
  if (totalWeight !== 100) {
    return fail(400, 'Variant traffic weights must sum to 100');
  }

  const { data: pathConflict } = await db
    .from('tests')
    .select('name')
    .eq('workspace_id', input.workspace_id)
    .eq('url_path', input.url_path)
    .eq('status', 'active')
    .limit(1)
    .single();

  if (pathConflict) {
    return fail(409, `Another active test "${pathConflict.name}" is already running on path "${input.url_path}". Pause it before creating a new test on the same path.`);
  }

  const { data: test, error: testError } = await db
    .from('tests')
    .insert({ workspace_id: input.workspace_id, name: input.name, url_path: input.url_path, status: input.status ?? 'active' })
    .select()
    .single();

  if (testError || !test) return fail(500, testError?.message || 'Failed to create test');

  const variantRows = input.variants.map((v, i) => ({
    test_id: test.id,
    name: v.name,
    page_id: v.page_id || null,
    redirect_url: v.redirect_url || null,
    proxy_mode: v.proxy_mode ?? true,
    traffic_weight: v.traffic_weight,
    is_control: i === 0 || v.is_control || false,
  }));

  const { data: newVariants, error: varError } = await db.from('test_variants').insert(variantRows as never).select('id, name, page_id');
  if (varError) return fail(500, varError.message);

  // First time each linked page becomes scannable — like attachPageAsVariant,
  // the HTML itself isn't changing here, but nothing could have scanned it
  // before now since it wasn't part of a test yet.
  for (const nv of (newVariants ?? []) as { id: string; name: string; page_id: string | null }[]) {
    if (!nv.page_id) continue;
    const { data: pageRow } = await db.from('pages').select('html_content, html_url').eq('id', nv.page_id).single();
    let scanHtml: string | null = pageRow?.html_content ?? null;
    if (!scanHtml && pageRow?.html_url) {
      try { scanHtml = await downloadHtml(pageRow.html_url); } catch { scanHtml = null; }
    }
    if (scanHtml) {
      await rescanVariantHtml(test.id, nv.id, nv.name, scanHtml);
    }
  }

  if (input.goals && input.goals.length > 0) {
    const goalRows = input.goals.map((g) => ({
      test_id: test.id,
      name: g.name,
      type: g.type,
      selector: g.selector || null,
      url_pattern: g.url_pattern || null,
      is_primary: g.is_primary || false,
    }));
    await db.from('conversion_goals').insert(goalRows as never);
  }

  const { data: fullTest } = await db
    .from('tests')
    .select(fullTestSelect())
    .eq('id', test.id)
    .single();

  return ok(fullTest);
}

export async function duplicateTest(
  testId: string,
  workspaceId: string,
  name: string,
  urlPath: string
): Promise<ServiceResult<unknown>> {
  const { data: src } = await db
    .from('tests')
    .select('workspace_id, name, url_path, status, head_scripts')
    .eq('id', testId)
    .single();
  if (!src) return fail(404, 'Page not found');

  const { data: clash } = await db
    .from('tests')
    .select('name')
    .eq('workspace_id', workspaceId)
    .eq('url_path', urlPath)
    .eq('status', 'active')
    .single();
  if (clash) {
    return fail(409, `Another active page "${clash.name}" is already on "${urlPath}". Choose a different path.`);
  }

  const { data: newTest, error: testErr } = await db
    .from('tests')
    .insert({
      workspace_id: workspaceId,
      name,
      url_path: urlPath,
      status: 'draft',
      head_scripts: src.head_scripts ?? null,
    } as never)
    .select('id')
    .single();
  if (testErr || !newTest) return fail(500, testErr?.message || 'Failed to duplicate page');

  const { data: srcVariants } = await db
    .from('test_variants')
    .select('id, name, redirect_url, page_id, proxy_mode, traffic_weight, is_control')
    .eq('test_id', testId)
    .order('created_at', { ascending: true });

  const variantIdMap = new Map<string, string>();
  for (const v of srcVariants ?? []) {
    let newPageId: string | null = null;
    let duplicatedHtml: string | null = null;
    if (v.page_id) {
      const { data: srcPage } = await db
        .from('pages')
        .select('workspace_id, name, html_content')
        .eq('id', v.page_id)
        .single();
      if (srcPage?.html_content) {
        const fileName = `${srcPage.workspace_id}/${crypto.randomUUID()}.html`;
        const htmlUrl = await uploadHtml(fileName, srcPage.html_content);
        const { data: newPage } = await db
          .from('pages')
          .insert({
            workspace_id: srcPage.workspace_id,
            name: srcPage.name,
            html_url: htmlUrl,
            html_content: srcPage.html_content,
          })
          .select('id')
          .single();
        newPageId = newPage?.id ?? null;
        duplicatedHtml = srcPage.html_content;
      }
    }

    const { data: newVariant } = await db
      .from('test_variants')
      .insert({
        test_id: newTest.id,
        name: v.name,
        redirect_url: newPageId ? null : v.redirect_url,
        page_id: newPageId,
        proxy_mode: newPageId ? false : v.proxy_mode,
        traffic_weight: v.traffic_weight,
        is_control: v.is_control,
      } as never)
      .select('id')
      .single();
    if (newVariant) {
      variantIdMap.set(v.id, newVariant.id);
      if (duplicatedHtml) {
        await rescanVariantHtml(newTest.id, newVariant.id, v.name, duplicatedHtml);
      }
    }
  }

  const { data: srcGoals } = await db
    .from('conversion_goals')
    .select('name, type, selector, url_pattern, is_primary, variant_id')
    .eq('test_id', testId);

  if (srcGoals && srcGoals.length > 0) {
    const goalRows = srcGoals.map((g) => ({
      test_id: newTest.id,
      name: g.name,
      type: g.type,
      selector: g.selector,
      url_pattern: g.url_pattern,
      is_primary: g.is_primary,
      variant_id: g.variant_id ? (variantIdMap.get(g.variant_id) ?? null) : null,
    }));
    await db.from('conversion_goals').insert(goalRows as never);
  }

  const { data: fullTest } = await db
    .from('tests')
    .select('*, test_variants(*, pages(id, name)), conversion_goals(*)')
    .eq('id', newTest.id)
    .single();

  return ok(fullTest);
}

/**
 * Soft-deletes pages linked to the test's variants, then hard-deletes the
 * test row (and its variants/goals via FK cascade) — same order and same
 * two queries as the dashboard's DELETE /api/tests/[id], extracted verbatim.
 */
export async function deleteTest(testId: string): Promise<ServiceResult<{ ok: true }>> {
  const { data: variants } = await db
    .from('test_variants')
    .select('page_id')
    .eq('test_id', testId)
    .not('page_id', 'is', null);

  const pageIds = Array.from(new Set((variants ?? []).map((v) => v.page_id).filter(Boolean)));
  if (pageIds.length > 0) {
    await db.from('pages').update({ deleted_at: new Date().toISOString() } as never).in('id', pageIds);
  }

  const { error } = await db.from('tests').delete().eq('id', testId);
  if (error) return fail(500, error.message);
  return ok({ ok: true });
}

export interface CreateVariantInput {
  name: string;
  html_content?: string;
  redirect_url?: string | null;
  proxy_mode?: boolean;
  traffic_weight: number;
}

/**
 * Fresh (blank) variant on an existing test — distinct from duplicateVariant,
 * which clones an existing one. Extracted verbatim from
 * POST /api/tests/[id]/variants: same plan-limit check, same
 * inline-data-uri-to-storage swap before HTML is ever stored, same
 * equalize-all-weights-after-insert behavior.
 */
export async function createVariant(
  testId: string,
  workspaceId: string,
  userRole: string,
  input: CreateVariantInput
): Promise<ServiceResult<unknown>> {
  if (!input.redirect_url && !input.html_content) {
    return fail(400, 'Either redirect_url or html_content is required');
  }

  if (userRole !== 'admin') {
    const { data: wsData } = await db.from('workspaces').select('client_id').eq('id', workspaceId).single();
    let planOwnerId: string | null = null;
    if (wsData) {
      const { data: clientData } = await db.from('clients').select('owner_id').eq('id', wsData.client_id).single();
      planOwnerId = clientData?.owner_id ?? null;
    }
    if (planOwnerId) {
      const { data: userRow } = await db.from('users').select('plan').eq('id', planOwnerId).single();
      const plan = userRow?.plan ?? 'free';
      const limit = PLAN_LIMITS[plan]?.variants ?? 2;
      if (isFinite(limit)) {
        const { count } = await db.from('test_variants').select('*', { count: 'exact', head: true }).eq('test_id', testId);
        if ((count ?? 0) >= limit) {
          return fail(403, `Your plan allows a maximum of ${limit} variants per test. Please upgrade for unlimited variants.`, { limitError: true });
        }
      }
    }
  }

  let pageId: string | null = null;
  let scanHtml: string | null = null;
  if (input.html_content) {
    const newPageId = crypto.randomUUID();
    const convertedHtml = (await takeOwnershipOfHtmlAssets(input.html_content, newPageId)).html;
    const fileName = `${workspaceId}/${crypto.randomUUID()}.html`;
    const htmlUrl = await uploadHtml(fileName, convertedHtml);

    const { data: page, error: pageErr } = await db
      .from('pages')
      .insert({ id: newPageId, workspace_id: workspaceId, name: input.name, html_url: htmlUrl, html_content: convertedHtml })
      .select('id')
      .single();
    if (pageErr) return fail(500, pageErr.message);
    pageId = page.id;
    scanHtml = convertedHtml;
  }

  const { data: newVariant, error: varErr } = await db.from('test_variants').insert({
    test_id: testId,
    name: input.name,
    redirect_url: pageId ? null : (input.redirect_url || null),
    page_id: pageId,
    proxy_mode: pageId ? false : (input.proxy_mode ?? true),
    traffic_weight: input.traffic_weight,
    is_control: false,
  }).select('id').single();
  if (varErr) return fail(500, varErr.message);

  if (scanHtml && newVariant) {
    await rescanVariantHtml(testId, newVariant.id, input.name, scanHtml);
  }

  const { data: allVariants } = await db
    .from('test_variants')
    .select('id')
    .eq('test_id', testId)
    .order('created_at', { ascending: true });

  if (allVariants && allVariants.length > 0) {
    const equalWeight = Math.floor(100 / allVariants.length);
    let rem = 100 - equalWeight * allVariants.length;
    for (const v of allVariants) {
      const w = equalWeight + (rem-- > 0 ? 1 : 0);
      await db.from('test_variants').update({ traffic_weight: w }).eq('id', v.id);
    }
  }

  const { data: fullTest, error: fetchErr } = await db.from('tests').select(fullTestSelect()).eq('id', testId).single();
  if (fetchErr) return fail(500, fetchErr.message);
  return ok(fullTest);
}

/**
 * Swaps which variant is the champion (is_control) — no existing route did
 * this; is_control was previously only ever set once, at creation time.
 * Refuses to promote an archived variant (it's out of rotation, promoting it
 * to control would put a 0%-weight variant in the control slot).
 */
export async function promoteToChampion(testId: string, variantId: string): Promise<ServiceResult<unknown>> {
  const { data: target } = await db
    .from('test_variants')
    .select('id, archived_at')
    .eq('id', variantId)
    .eq('test_id', testId)
    .single();
  if (!target) return fail(404, 'Variant not found');
  if (target.archived_at) return fail(400, 'Cannot promote an archived variant — unarchive it first');

  await db.from('test_variants').update({ is_control: false }).eq('test_id', testId);
  const { error } = await db.from('test_variants').update({ is_control: true }).eq('id', variantId);
  if (error) return fail(500, error.message);

  const { data: fullTest, error: fetchErr } = await db.from('tests').select(fullTestSelect()).eq('id', testId).single();
  if (fetchErr) return fail(500, fetchErr.message);
  return ok(fullTest);
}

export interface DateRangeOptions { from?: string | null; to?: string | null }

/**
 * Overall per-variant stats + statistical significance vs. control, extracted
 * verbatim from GET /api/tests/[id]/analytics. Uses the same server-side
 * Postgres RPC aggregation as the dashboard (test_variant_stats /
 * test_variant_device_stats) — never fetches raw event rows into JS, which
 * used to hit PostgREST's default 1,000-row cap and silently truncate large
 * tests. Caller must already have rejected viewers — analytics is restricted
 * beyond the normal viewer-can-read rule (matches the dashboard exactly).
 */
export async function getTestAnalytics(testId: string, opts: DateRangeOptions): Promise<ServiceResult<unknown>> {
  const { from, to } = opts;

  const { data: test, error: testError } = await db
    .from('tests')
    .select('*, test_variants(*, pages(id, name, draft_html_content)), conversion_goals(*)')
    .eq('id', testId)
    .single();
  if (testError || !test) return fail(404, 'Not found');

  interface VariantRow { id: string; name: string; is_control: boolean; traffic_weight: number; pages?: { id: string; name: string } | null }
  const variants = (test.test_variants || []) as VariantRow[];

  const primaryGoal = (test.conversion_goals || []).find((g: { is_primary: boolean }) => g.is_primary) || (test.conversion_goals || [])[0] || null;

  const { data: rpcStats, error: rpcError } = await db.rpc('test_variant_stats', {
    p_test_id: testId,
    p_from: from ? `${from}T00:00:00Z` : null,
    p_to: to ? `${to}T23:59:59Z` : null,
  });
  if (rpcError) return fail(500, rpcError.message);

  const { data: rpcDeviceStats, error: rpcDeviceError } = await db.rpc('test_variant_device_stats', {
    p_test_id: testId,
    p_from: from ? `${from}T00:00:00Z` : null,
    p_to: to ? `${to}T23:59:59Z` : null,
  });
  if (rpcDeviceError) return fail(500, rpcDeviceError.message);

  const statsByVariant = new Map(
    (rpcStats || []).map((r: { variant_id: string; views: number; unique_visitors: number; conversions: number; goal_hits: number }) => [r.variant_id, r])
  );

  const deviceStatsByVariant = new Map<string, { desktop?: { views: number; unique_visitors: number; conversions: number }; mobile?: { views: number; unique_visitors: number; conversions: number } }>();
  for (const r of (rpcDeviceStats || []) as { variant_id: string; device_type: 'mobile' | 'desktop'; views: number; unique_visitors: number; conversions: number }[]) {
    const entry = deviceStatsByVariant.get(r.variant_id) || {};
    entry[r.device_type] = { views: Number(r.views), unique_visitors: Number(r.unique_visitors), conversions: Number(r.conversions) };
    deviceStatsByVariant.set(r.variant_id, entry);
  }

  const variantStats = variants.map((variant) => {
    const row = statsByVariant.get(variant.id) as { views: number; unique_visitors: number; conversions: number; goal_hits: number } | undefined;
    const views = Number(row?.views || 0);
    const uniqueVisitors = Number(row?.unique_visitors || 0);
    const conversions = Number(row?.conversions || 0);
    const goalHits = Number(row?.goal_hits || 0);
    const cvr = uniqueVisitors > 0 ? conversions / uniqueVisitors : 0;

    const deviceRow = deviceStatsByVariant.get(variant.id);
    const desktop = deviceRow?.desktop;
    const mobile = deviceRow?.mobile;
    const desktopUniqueVisitors = desktop?.unique_visitors || 0;
    const desktopConversions = desktop?.conversions || 0;
    const mobileUniqueVisitors = mobile?.unique_visitors || 0;
    const mobileConversions = mobile?.conversions || 0;

    return {
      variant,
      views,
      uniqueVisitors,
      conversions,
      goalHits,
      cvr,
      desktopUniqueVisitors,
      desktopConversions,
      desktopCvr: desktopUniqueVisitors > 0 ? desktopConversions / desktopUniqueVisitors : 0,
      mobileUniqueVisitors,
      mobileConversions,
      mobileCvr: mobileUniqueVisitors > 0 ? mobileConversions / mobileUniqueVisitors : 0,
      confidence: null as number | null,
      isWinner: false,
    };
  });

  // Confidence vs control (chi-square trial count = unique visitors, not raw
  // pageviews — each visitor is one Bernoulli trial, a reload isn't).
  const control = variantStats.find((v) => v.variant.is_control) || variantStats[0];
  if (control) {
    for (const stat of variantStats) {
      if (stat.variant.id === control.variant.id) continue;
      stat.confidence = confidencePercent(control.uniqueVisitors, control.conversions, stat.uniqueVisitors, stat.conversions);
    }
  }

  const winnerId = findWinner(variantStats.map((s) => ({ id: s.variant.id, views: s.uniqueVisitors, conversions: s.conversions })));
  for (const stat of variantStats) {
    stat.isWinner = stat.variant.id === winnerId;
  }

  const totalViews = variantStats.reduce((s, v) => s + v.views, 0);
  const totalUniqueVisitors = variantStats.reduce((s, v) => s + v.uniqueVisitors, 0);
  const totalConversions = variantStats.reduce((s, v) => s + v.conversions, 0);

  return ok({ test, primaryGoal, variantStats, totalViews, totalUniqueVisitors, totalConversions });
}

export interface DailyStatsOptions extends DateRangeOptions { variantId?: string | null }

/**
 * Daily time-series stats per variant, extracted verbatim from
 * GET /api/tests/[id]/reporting. Totals are computed via test_variant_stats
 * (whole-range dedup), not by summing the daily buckets — summing would
 * double-count a visitor who returns on a second day.
 */
export async function getTestDailyStats(testId: string, opts: DailyStatsOptions): Promise<ServiceResult<unknown>> {
  const { from, to, variantId } = opts;

  const { data: test, error: testError } = await db
    .from('tests')
    .select('id, status, test_variants(id, name, is_control), conversion_goals(id)')
    .eq('id', testId)
    .single();
  if (testError || !test) return fail(404, 'Not found');

  const variants = (test.test_variants || []) as Array<{ id: string; name: string; is_control: boolean }>;

  const { data: rpcRows, error: rpcError } = await db.rpc('test_variant_daily_stats', {
    p_test_id: testId,
    p_from: from ? `${from}T00:00:00Z` : null,
    p_to: to ? `${to}T23:59:59Z` : null,
  });
  if (rpcError) return fail(500, rpcError.message);

  type DailyRow = { day: string; variant_id: string; views: number; unique_visitors: number; conversions: number };
  let rows = (rpcRows || []) as DailyRow[];
  if (variantId && variantId !== 'all') rows = rows.filter((r) => r.variant_id === variantId);

  if (rows.length === 0) {
    return ok({ variants, daily: [], totals: { visitors: 0, views: 0, conversions: 0, cvr: 0 } });
  }

  const buckets = new Map<string, DailyRow[]>();
  for (const r of rows) {
    if (!buckets.has(r.day)) buckets.set(r.day, []);
    buckets.get(r.day)!.push(r);
  }

  const sortedDates = Array.from(buckets.keys()).sort();

  const daily = sortedDates.map((date) => {
    const dayRows = buckets.get(date)!;
    const row: Record<string, unknown> = { date };

    for (const variant of variants) {
      const r = dayRows.find((dr) => dr.variant_id === variant.id);
      const views = Number(r?.views || 0);
      const visitors = Number(r?.unique_visitors || 0);
      const conversions = Number(r?.conversions || 0);
      const cvr = visitors > 0 ? parseFloat(((conversions / visitors) * 100).toFixed(2)) : 0;

      row[`${variant.id}_views`] = views;
      row[`${variant.id}_visitors`] = visitors;
      row[`${variant.id}_conversions`] = conversions;
      row[`${variant.id}_cvr`] = cvr;
    }

    const overallViews = dayRows.reduce((s, r) => s + Number(r.views || 0), 0);
    const overallVisitors = dayRows.reduce((s, r) => s + Number(r.unique_visitors || 0), 0);
    const overallConversions = dayRows.reduce((s, r) => s + Number(r.conversions || 0), 0);

    row['overall_views'] = overallViews;
    row['overall_visitors'] = overallVisitors;
    row['overall_conversions'] = overallConversions;
    row['overall_cvr'] = overallVisitors > 0 ? parseFloat(((overallConversions / overallVisitors) * 100).toFixed(2)) : 0;

    return row;
  });

  const { data: totalsRpcRows, error: totalsRpcError } = await db.rpc('test_variant_stats', {
    p_test_id: testId,
    p_from: from ? `${from}T00:00:00Z` : null,
    p_to: to ? `${to}T23:59:59Z` : null,
  });
  if (totalsRpcError) return fail(500, totalsRpcError.message);

  type TotalsRow = { variant_id: string; views: number; unique_visitors: number; conversions: number };
  let totalsRows = (totalsRpcRows || []) as TotalsRow[];
  if (variantId && variantId !== 'all') totalsRows = totalsRows.filter((r) => r.variant_id === variantId);

  const totalViews = totalsRows.reduce((s, r) => s + Number(r.views || 0), 0);
  const totalVisitors = totalsRows.reduce((s, r) => s + Number(r.unique_visitors || 0), 0);
  const totalConversions = totalsRows.reduce((s, r) => s + Number(r.conversions || 0), 0);
  const cvr = totalVisitors > 0 ? parseFloat(((totalConversions / totalVisitors) * 100).toFixed(2)) : 0;

  return ok({ variants, daily, totals: { visitors: totalVisitors, views: totalViews, conversions: totalConversions, cvr } });
}
