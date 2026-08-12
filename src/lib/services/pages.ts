import { db } from '@/lib/supabase-server';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl, inlineDataUrisToStorage } from '@/lib/storage';
import { isTestVariantPage, getLinkedVariant } from '@/lib/page-drafts';
import { PLAN_LIMITS } from '@/lib/plans';
import { ok, fail, ServiceResult } from './types';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export interface CreatePageInput {
  workspace_id: string;
  name: string;
  vertical: string;
  prompt?: string | null;
  schema_json?: Record<string, unknown> | null;
  conversation_json?: unknown[];
  html_url?: string | null;
  html_content?: string | null;
  slug?: string;
  created_by: string;
}

/**
 * Creates a standalone page row — a Draft, not linked to any test, exactly
 * like a human-created AI Builder draft. This is the endpoint the MCP
 * create_page tool should call: it takes raw HTML/content directly and does
 * NOT require going through SplitLab's own schema-based generate/build
 * pipeline, since Claude authors the content itself.
 *
 * html_content is run through inlineDataUrisToStorage before it's ever
 * stored — the same pipeline every other HTML-accepting write path already
 * uses (create_variant, from-html, replace_variant, save-as-new). This is
 * what makes "user pastes an image into Claude, Claude writes an <img
 * src="data:image/...;base64,..."> tag" work: the base64 payload is
 * extracted, its decoded bytes are checked against the declared MIME type,
 * uploaded to the public ai-pages-images bucket, and swapped for a real URL
 * — no separate upload tool needed, and no SSRF surface, since nothing here
 * ever fetches a caller-supplied URL. Generating the id upfront (rather than
 * letting the DB default it) is required so the image upload path — which is
 * keyed by pageId — has an id to use before the row exists.
 */
export async function createPage(input: CreatePageInput): Promise<ServiceResult<unknown>> {
  const pageId = crypto.randomUUID();
  const convertedHtml = typeof input.html_content === 'string'
    ? await inlineDataUrisToStorage(input.html_content, pageId)
    : input.html_content;

  // Every other page-creation path (AI generate/build, raw-HTML paste into a
  // variant) uploads to storage and sets html_url — the AI Pages builder UI
  // gates its schema-prep/preview effects on html_url being present. MCP's
  // caller only ever supplies html_content, so upload it here too rather
  // than leaving html_url null, which otherwise left MCP-created pages stuck
  // on a blank builder screen.
  let htmlUrl = input.html_url ?? null;
  if (!htmlUrl && typeof convertedHtml === 'string') {
    htmlUrl = await uploadHtml(`${input.workspace_id}/${pageId}.html`, convertedHtml);
  }

  const { data, error } = await db
    .from('pages')
    .insert({
      id: pageId,
      workspace_id: input.workspace_id,
      name: input.name,
      slug: input.slug ?? crypto.randomUUID(),
      prompt: input.prompt ?? null,
      vertical: input.vertical,
      schema_json: input.schema_json ?? null,
      conversation_json: input.conversation_json ?? [],
      html_url: htmlUrl,
      html_content: typeof convertedHtml === 'string' && convertedHtml.length < 500_000 ? convertedHtml : null,
      status: 'active',
      source_type: 'ai_generated',
      created_by: input.created_by,
      version: 1,
    })
    .select()
    .single();

  if (error) return fail(500, error.message);
  return ok(data);
}

export interface UpdatePageInput {
  name?: string;
  prompt?: string;
  html_content?: string;
  html_url?: string;
  slug?: string;
  tags?: string[];
  status?: 'active' | 'archived';
  schema_json?: Record<string, unknown>;
  conversation_json?: unknown[];
  draft?: boolean;
}
export interface PageMeta { html_url: string | null; schema_json: Record<string, unknown> | null }

/**
 * Draft-vs-live split, extracted verbatim from PATCH /api/pages/[id].
 * When `draft: true` AND the page backs a test variant, writes land in
 * draft_html_content/draft_schema_json only — live HTML, storage, and
 * selectors are never touched. The MCP update_page tool must always pass
 * draft: true (or simply never expose a live-writing path) — only
 * publish_page/replace_variant are allowed to write live.
 *
 * html_content, if present, is run through inlineDataUrisToStorage up front
 * — before the draft-vs-live branch below, since both branches persist
 * data.html_content somewhere and a pasted image should get extracted either
 * way. Same reasoning as createPage's own doc comment.
 */
export async function updatePageDraftOrLive(
  pageId: string,
  pageMeta: PageMeta,
  input: UpdatePageInput
): Promise<ServiceResult<unknown>> {
  const { draft, ...data } = input;

  if (typeof data.html_content === 'string') {
    data.html_content = await inlineDataUrisToStorage(data.html_content, pageId);
  }

  const isDraftWrite = draft === true && (await isTestVariantPage(pageId));

  if (isDraftWrite) {
    const draftPayload: Record<string, unknown> = {};
    if (data.html_content !== undefined) draftPayload.draft_html_content = data.html_content;
    if (data.schema_json !== undefined) draftPayload.draft_schema_json = data.schema_json;

    const { data: updated, error } = await db
      .from('pages')
      .update(draftPayload)
      .eq('id', pageId)
      .select()
      .single();

    if (error) return fail(500, error.message);
    return ok(updated);
  }

  let storageUrl: string | undefined;
  if (data.html_content) {
    const fileName = pageMeta.html_url ? fileNameFromUrl(pageMeta.html_url) : `${pageId}.html`;
    if (fileName) storageUrl = await uploadHtml(fileName, data.html_content);
  }

  const htmlReplaced = Boolean(data.html_content || data.html_url);
  const schemaNowStale = htmlReplaced && data.schema_json === undefined && !!pageMeta.schema_json;

  const updatePayload = {
    ...data,
    ...(storageUrl ? { html_url: storageUrl } : {}),
    ...(htmlReplaced ? { field_selectors_json: null } : {}),
    ...(data.html_url && !data.html_content ? { html_content: null } : {}),
    ...(schemaNowStale ? { schema_json: null, conversation_json: [] } : {}),
  };

  if (htmlReplaced) {
    await db.from('personalization_rules').delete().eq('page_id', pageId);

    const linkedVariant = await getLinkedVariant(pageId);
    if (linkedVariant) {
      const { data: testRow } = await db
        .from('tests')
        .select('scan_results')
        .eq('id', linkedVariant.test_id)
        .single();
      const existingScans = testRow?.scan_results as { variants?: { variant_id: string }[] } | null;
      if (existingScans?.variants?.some((v) => v.variant_id === linkedVariant.id)) {
        const pruned = { variants: existingScans.variants.filter((v) => v.variant_id !== linkedVariant.id) };
        await db.from('tests').update({ scan_results: pruned }).eq('id', linkedVariant.test_id);
      }
    }
  }

  const { data: updated, error } = await db
    .from('pages')
    .update(updatePayload)
    .eq('id', pageId)
    .select()
    .single();

  if (error) return fail(500, error.message);
  return ok(updated);
}

/**
 * Undeleted pages for a workspace, extracted verbatim from
 * GET /api/workspaces/[id]/pages — reused by the MCP list_pages tool so
 * Claude sees exactly what the dashboard's page list shows.
 */
export async function listWorkspacePages(workspaceId: string): Promise<ServiceResult<unknown[]>> {
  const { data, error } = await db
    .from('pages')
    .select('*')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) return fail(500, error.message);
  return ok(data ?? []);
}

/**
 * Single page fetch with the same on-demand storage fallback as
 * GET /api/pages/[id] — resolves html_content from Storage when only
 * html_url is set, so callers never see a null body for a built page.
 */
export async function getPageWithContent(pageId: string): Promise<ServiceResult<Record<string, unknown>>> {
  const { data, error } = await db.from('pages').select('*').eq('id', pageId).single();
  if (error || !data) return fail(404, 'Not found');

  if (!data.html_content && data.html_url) {
    const filePath = fileNameFromUrl(data.html_url);
    if (filePath) {
      try {
        data.html_content = await downloadHtmlByPath(filePath);
      } catch { /* fall through with html_content still null */ }
    }
  }

  return ok(data);
}

/** Extracted verbatim from POST /api/pages/[id]/unpublish. */
export async function unpublishPage(pageId: string): Promise<ServiceResult<{ slug: string | null }>> {
  const { data: page } = await db.from('pages').select('slug').eq('id', pageId).single();
  if (!page) return fail(404, 'Not found');

  const { error } = await db
    .from('pages')
    .update({ is_published: false, published_url: null, updated_at: new Date().toISOString() })
    .eq('id', pageId);

  if (error) return fail(500, error.message);
  return ok({ slug: page.slug });
}

/**
 * Soft delete only — extracted verbatim from POST /api/pages/[id]/delete.
 * Deliberately NOT the hard `db.delete()` in the legacy DELETE handler on
 * pages/[id]/route.ts; MCP's delete_page must match the reversible
 * (deleted_at) behavior the dashboard's own delete button uses.
 */
export async function softDeletePage(pageId: string): Promise<ServiceResult<{ slug: string | null }>> {
  const { data: page } = await db.from('pages').select('slug').eq('id', pageId).is('deleted_at', null).single();
  if (!page) return fail(404, 'Not found');

  const { error } = await db
    .from('pages')
    .update({ deleted_at: new Date().toISOString(), is_published: false, published_url: null, updated_at: new Date().toISOString() })
    .eq('id', pageId);

  if (error) return fail(500, error.message);
  return ok({ slug: page.slug });
}

export interface PublishPageRow {
  html_url: string | null;
  html_content: string | null;
  slug: string | null;
  status: string;
}

/**
 * The only path that promotes a page's HTML onto its live, published URL.
 * html_url is normally already set (every existing page-build path uploads
 * to Storage immediately), but content-only pages — e.g. MCP's create_page,
 * which stores raw html_content without a Storage round-trip, matching the
 * plain POST /api/pages convention — never had one. Falls back to a fresh
 * `pages/{id}.html` path in that case instead of assuming html_url exists.
 */
export async function publishPage(pageId: string, page: PublishPageRow): Promise<ServiceResult<{ published_url: string; slug: string }>> {
  if (!page.html_url && !page.html_content) {
    return fail(400, 'Page has not been built yet');
  }

  let html = page.html_content;
  if (!html) {
    const filePath = fileNameFromUrl(page.html_url as string);
    html = await downloadHtmlByPath(filePath);
  }

  const trackerScript = `<script src="${APP_URL}/tracker.js"></script>`;
  html = html.replace('<!-- TRACKER_PLACEHOLDER -->', trackerScript);

  const slug = page.slug ?? crypto.randomUUID();

  const storagePath = page.html_url ? fileNameFromUrl(page.html_url) : `pages/${pageId}.html`;
  const htmlUrl = await uploadHtml(storagePath, html);

  const publishedUrl = `${APP_URL}/pages/${slug}`;

  await db.from('pages').update({
    is_published: true,
    slug,
    html_url: htmlUrl,
    html_content: html.length < 500_000 ? html : null,
    published_url: publishedUrl,
    updated_at: new Date().toISOString(),
  }).eq('id', pageId);

  return ok({ published_url: publishedUrl, slug });
}

/**
 * Wires a standalone page directly into an existing test as a new variant at
 * 0% traffic — no copy, no new page row. Extracted verbatim from
 * POST /api/pages/[id]/save-as-variant. A page can only ever back one
 * variant (enforced via getLinkedVariant below) — otherwise an edit meant
 * for one test would silently change what another test serves, since both
 * would share this same page's HTML.
 */
export async function attachPageAsVariant(
  pageId: string,
  page: { workspace_id: string; html_content: string | null; html_url: string | null },
  testId: string,
  testWorkspaceId: string,
  variantName: string,
  userRole: string
): Promise<ServiceResult<{ testId: string; variantId: string }>> {
  if (testWorkspaceId !== page.workspace_id) return fail(404, 'Test not found');
  if (!page.html_content && !page.html_url) return fail(400, 'Build this page before adding it to a test');

  const existingLink = await getLinkedVariant(pageId);
  if (existingLink) return fail(400, 'This page is already associated with a test.');

  if (userRole !== 'admin') {
    const { data: wsData } = await db.from('workspaces').select('client_id').eq('id', page.workspace_id).single();
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

  // 0% traffic, existing variants' weights untouched — stays inert until
  // the user ramps traffic up manually, same as the manual dashboard flow.
  const { data: variant, error: varErr } = await db
    .from('test_variants')
    .insert({ test_id: testId, name: variantName, page_id: pageId, proxy_mode: false, traffic_weight: 0, is_control: false })
    .select('id')
    .single();
  if (varErr) return fail(500, varErr.message);

  return ok({ testId, variantId: variant.id });
}

/**
 * Forks a variant page's current draft (or live HTML, if no draft) into a
 * brand-new page + new test_variants row at 0% traffic — the non-destructive
 * alternative to replaceVariantLive. Extracted verbatim from
 * POST /api/pages/[id]/save-as-new.
 */
export async function forkPageAsNewVariant(
  pageId: string,
  page: {
    workspace_id: string;
    vertical: string | null;
    html_content: string | null;
    schema_json: Record<string, unknown> | null;
    draft_html_content: string | null;
    draft_schema_json: Record<string, unknown> | null;
  },
  variantName: string,
  userRole: string
): Promise<ServiceResult<{ pageId: string; testId: string }>> {
  const linkedVariant = await getLinkedVariant(pageId);
  if (!linkedVariant) return fail(400, 'This page is not linked to a test variant');

  const html = page.draft_html_content ?? page.html_content;
  if (!html) return fail(400, 'No HTML to save');
  const schemaJson = page.draft_schema_json ?? page.schema_json;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const testsRel = linkedVariant.tests as any;
  const testName = Array.isArray(testsRel) ? testsRel[0]?.name : testsRel?.name;
  const pageName = `${testName ?? 'Test'} - ${variantName}`;

  if (userRole !== 'admin') {
    const { data: wsData } = await db.from('workspaces').select('client_id').eq('id', page.workspace_id).single();
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
        const { count } = await db.from('test_variants').select('*', { count: 'exact', head: true }).eq('test_id', linkedVariant.test_id);
        if ((count ?? 0) >= limit) {
          return fail(403, `Your plan allows a maximum of ${limit} variants per test. Please upgrade for unlimited variants.`, { limitError: true });
        }
      }
    }
  }

  const fileName = `${page.workspace_id}/${crypto.randomUUID()}.html`;
  const htmlUrl = await uploadHtml(fileName, html);

  const { data: newPage, error } = await db
    .from('pages')
    .insert({
      workspace_id: page.workspace_id,
      name: pageName,
      html_url: htmlUrl,
      html_content: html.length < 500_000 ? html : null,
      schema_json: schemaJson ?? null,
      vertical: page.vertical ?? 'other',
      source_type: 'ai_generated',
    })
    .select('id')
    .single();
  if (error) return fail(500, error.message);

  const { error: varErr } = await db.from('test_variants').insert({
    test_id: linkedVariant.test_id,
    name: variantName,
    page_id: newPage.id,
    proxy_mode: false,
    traffic_weight: 0,
    is_control: false,
  });
  if (varErr) return fail(500, varErr.message);

  // The fork is "done" — clear the draft on the original so it shows a
  // clean, no-pending-changes state back on the test.
  await db.from('pages').update({ draft_html_content: null, draft_schema_json: null }).eq('id', pageId);

  return ok({ pageId: newPage.id, testId: linkedVariant.test_id });
}

/**
 * Promotes a variant page's draft onto the live HTML a test is actually
 * serving — the only place a variant page's live columns get touched by the
 * AI editor. Extracted verbatim from POST /api/pages/[id]/replace-variant.
 */
export async function replaceVariantLive(
  pageId: string,
  page: { html_url: string | null; draft_html_content: string | null; draft_schema_json: Record<string, unknown> | null }
): Promise<ServiceResult<{ html_url: string; schema_json: unknown }>> {
  const linkedVariant = await getLinkedVariant(pageId);
  if (!linkedVariant) return fail(400, 'This page is not linked to a test variant');
  if (!page.draft_html_content) return fail(400, 'No unsaved changes to replace the variant with');

  // Swap embedded base64 images for real hosted files before this HTML goes
  // live — see storage.ts's inlineDataUrisToStorage for why.
  const convertedDraftHtml = await inlineDataUrisToStorage(page.draft_html_content, pageId);
  const storagePath = page.html_url ? fileNameFromUrl(page.html_url) : `pages/${pageId}.html`;
  const htmlUrl = await uploadHtml(storagePath, convertedDraftHtml);

  const updatePayload: Record<string, unknown> = {
    html_url: htmlUrl,
    html_content: convertedDraftHtml.length < 500_000 ? convertedDraftHtml : null,
    draft_html_content: null,
    draft_schema_json: null,
    field_selectors_json: null,
    updated_at: new Date().toISOString(),
  };
  if (page.draft_schema_json) updatePayload.schema_json = page.draft_schema_json;

  await db.from('personalization_rules').delete().eq('page_id', pageId);

  // Live markup replaced by the AI draft — this variant's cached scan no
  // longer reflects the page.
  const { data: testRow } = await db.from('tests').select('scan_results').eq('id', linkedVariant.test_id).single();
  const existingScans = testRow?.scan_results as { variants?: { variant_id: string }[] } | null;
  if (existingScans?.variants?.some((v) => v.variant_id === linkedVariant.id)) {
    const pruned = { variants: existingScans.variants.filter((v) => v.variant_id !== linkedVariant.id) };
    await db.from('tests').update({ scan_results: pruned }).eq('id', linkedVariant.test_id);
  }

  const { data: updated, error } = await db
    .from('pages')
    .update(updatePayload)
    .eq('id', pageId)
    .select('html_url, schema_json')
    .single();
  if (error) return fail(500, error.message);

  return ok({ html_url: updated.html_url, schema_json: updated.schema_json });
}

/**
 * Sets a page's slug — the one field that takes effect immediately rather
 * than staging as a draft, matching Unbounce's own exception for URL/slug
 * changes. `pages.slug` has no DB-level UNIQUE constraint (only clients.slug
 * and workspaces.slug do — checked against supabase/migrations), and
 * pages/[slug]/route.ts resolves published pages by a bare `.eq('slug', …)`
 * lookup, so a collision would silently break whichever of the two pages
 * that query happens to return — enforced here at the application level
 * instead, same as the workspace-scoped url_path collision check tests get
 * in updateTest.
 */
export async function setPageSlug(pageId: string, newSlug: string): Promise<ServiceResult<{ old_slug: string | null; slug: string; published_url: string | null }>> {
  const normalized = newSlug.trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(normalized)) {
    return fail(400, 'Slug must be lowercase letters, numbers, and hyphens only (e.g. "spring-sale"), no leading/trailing/double hyphens.');
  }

  const { data: page } = await db.from('pages').select('slug, is_published').eq('id', pageId).is('deleted_at', null).single();
  if (!page) return fail(404, 'Not found');

  if (normalized === page.slug) {
    return ok({ old_slug: page.slug, slug: normalized, published_url: page.is_published ? `${APP_URL}/pages/${normalized}` : null });
  }

  const { data: clash } = await db
    .from('pages')
    .select('id')
    .eq('slug', normalized)
    .is('deleted_at', null)
    .neq('id', pageId)
    .maybeSingle();
  if (clash) return fail(409, `Slug "${normalized}" is already used by another page.`);

  const updatePayload: Record<string, unknown> = { slug: normalized, updated_at: new Date().toISOString() };
  if (page.is_published) updatePayload.published_url = `${APP_URL}/pages/${normalized}`;

  const { error } = await db.from('pages').update(updatePayload).eq('id', pageId);
  if (error) return fail(500, error.message);

  return ok({ old_slug: page.slug, slug: normalized, published_url: page.is_published ? `${APP_URL}/pages/${normalized}` : null });
}
