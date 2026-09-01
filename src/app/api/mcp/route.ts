import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { extractBearerToken, resolveMcpPrincipal, principalHasWriteScope, McpPrincipal } from '@/lib/mcp/auth';
import { checkMcpRateLimit } from '@/lib/mcp/rate-limit';
import { logMcpAction } from '@/lib/mcp/audit';
import { listClientsForUser } from '@/lib/services/clients';
import {
  listWorkspacePages, createPage, getPageWithContent, updatePageDraftOrLive,
  publishPage, unpublishPage, softDeletePage,
  attachPageAsVariant, forkPageAsNewVariant, replaceVariantLive, setPageSlug,
} from '@/lib/services/pages';
import {
  listWorkspaceTests, getTestDetail, updateTest, duplicateVariant, duplicateTest, deleteTest,
  createVariant, createTest, promoteToChampion, getTestAnalytics, getTestDailyStats, TestMeta,
} from '@/lib/services/tests';
import { listDomains, addDomain, verifyDomain, deleteDomain, buildDnsInstructions } from '@/lib/services/domains';
import { resolveWorkspaceRole, resolveOwnerPlan, resolveTestWorkspaceRole } from '@/lib/workspace-auth';
import { getLinkedVariant } from '@/lib/page-drafts';
import { PLAN_LIMITS } from '@/lib/plans';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

// Matches AnalyticsClient.tsx's nameSlug/testUrl construction exactly — the
// [slug] path segment in src/app/[slug]/[testId]/route.ts is never actually
// read (only testId is), so this is cosmetic, but it must still be built the
// same way the dashboard's own "test link" does for consistency. This is the
// ONLY link that runs through the real /api/serve pipeline (weighted variant
// assignment, sticky cookies, tracker.js injection) without needing a custom
// domain configured — unlike a page's preview_url, which is an
// authenticated, untracked raw-HTML view for a logged-in human only.
function buildTestUrl(test: { id: string; name: string; url_path: string }): string {
  const nameSlug = test.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${APP_URL}/${nameSlug}/${test.id}${test.url_path === '/' ? '' : test.url_path}`;
}

// Hand-rolled JSON-RPC 2.0 / MCP "stateless streamable HTTP" transport,
// rather than depending on @modelcontextprotocol/sdk. That SDK's server
// transports (StreamableHTTPServerTransport, SSEServerTransport) are built
// around Node's http.IncomingMessage/ServerResponse, not the Fetch
// Request/Response Next.js App Router route handlers use — wiring the two
// together needs an adapter whose current compatibility with this SDK
// version and Next 14.1 isn't something to guess at blind. A single POST
// endpoint that parses JSON-RPC in and returns JSON-RPC out is spec-legal
// for MCP's stateless mode (no SSE) and is easy to verify by hand. Swap to
// the official SDK later once its Next.js adapter story is confirmed.

const SERVER_INFO = { name: 'splitlab', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}
function toolContent(data: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) };
}

/**
 * Every write tool below needs the SAME two checks the equivalent dashboard
 * route makes: (1) workspace role via resolveWorkspaceRole — viewers are
 * rejected exactly like a viewer clicking the same button in the UI, and
 * (2) OAuth write scope — a read-only-scoped token can't slip through even
 * if the underlying user is a manager/admin. Reads only need the role check
 * (viewers CAN read), so this returns the role for the caller to branch on.
 */
async function requireWorkspaceAccess(
  principal: McpPrincipal,
  workspaceId: string,
  opts: { write: boolean }
): Promise<{ ok: true; role: 'manager' | 'viewer' } | { ok: false; error: string }> {
  const role = await resolveWorkspaceRole(workspaceId, principal.id, principal.role);
  if (!role) return { ok: false, error: 'Forbidden — no access to this workspace' };
  if (opts.write) {
    if (role === 'viewer') return { ok: false, error: 'Forbidden — viewer role cannot make changes' };
    if (!principalHasWriteScope(principal)) return { ok: false, error: 'Forbidden — this connection is read-only scoped' };
  }
  return { ok: true, role };
}

/**
 * Same shape as requireWorkspaceAccess but keyed off a test id — every
 * Phase 2 tool operates on a test/variant, not a workspace directly. Reuses
 * resolveTestWorkspaceRole, which itself 404s (via null) on a nonexistent
 * test before ever resolving a role, same as the dashboard's PATCH/DELETE
 * handlers on /api/tests/[id].
 */
async function requireTestAccess(
  principal: McpPrincipal,
  testId: string,
  opts: { write: boolean }
): Promise<{ ok: true; workspaceId: string; role: 'manager' | 'viewer' } | { ok: false; error: string }> {
  const resolved = await resolveTestWorkspaceRole(testId, principal.id, principal.role);
  if (!resolved || !resolved.role) return { ok: false, error: 'Not found' };
  if (opts.write) {
    if (resolved.role === 'viewer') return { ok: false, error: 'Forbidden — viewer role cannot make changes' };
    if (!principalHasWriteScope(principal)) return { ok: false, error: 'Forbidden — this connection is read-only scoped' };
  }
  return { ok: true, workspaceId: resolved.workspaceId, role: resolved.role };
}

/**
 * create_page/update_page are Claude authoring content directly — the exact
 * same category of feature as generate/build/follow-up, which all gate on
 * the owner's aiPages plan entitlement (src/lib/plans.ts). The underlying
 * service functions these MCP tools call (createPage/updatePageDraftOrLive)
 * also back the dashboard's manual "paste HTML" / WYSIWYG paths, which are
 * intentionally NOT plan-gated — so the gate has to live here, in the MCP
 * tool handler, rather than in the shared service function.
 */
async function requireAiPagesPlan(principal: McpPrincipal, workspaceId: string): Promise<string | null> {
  if (principal.role === 'admin') return null;
  const ownerPlan = await resolveOwnerPlan(workspaceId);
  if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
    return 'AI page editing requires a Growth, Agency, or Scale plan. Please upgrade to use this feature.';
  }
  return null;
}

/** Fetches a page's workspace_id, 404-shaped for tool handlers. */
async function pageWorkspaceId(pageId: string): Promise<string | null> {
  const result = await getPageWithContent(pageId);
  if (!result.ok) return null;
  return (result.data as { workspace_id: string }).workspace_id;
}

// Phase 0: whoami/list_clients — smoke-test tools validating the OAuth
// handshake and principal-resolution path end to end.
// Phase 1 (this file, MCP_ROADMAP.md): connect → describe → build → preview
// → publish for standalone Draft pages. Variant/test tools are Phase 2.
const TOOLS = [
  {
    name: 'whoami',
    description: "Returns the connected SplitLab user's id, role, and plan. Use this to confirm the connection is working and to understand the caller's permissions before doing anything else.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_clients',
    description: 'Lists the clients (agency sub-accounts) the connected user can see, each with their workspaces (id, name, slug). Always resolve which client/workspace to work in before creating or editing anything — the same rule as Unbounce\'s "always specify the client you\'re working in."',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_pages',
    description: 'Lists the non-deleted pages in a workspace (id, name, slug, status, is_published, published_url, whether it has an unpublished draft). Call list_clients first to get a workspace_id.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', description: 'Workspace UUID from list_clients' } },
      required: ['workspace_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_page',
    description: 'Creates a new standalone page as an unpublished Draft in the given workspace, from HTML you write yourself. The page is a real database row from the moment this is called — nothing lives "in Claude." It is NOT published and NOT attached to any A/B test; use publish_page to make it live, or attach it to a test through the SplitLab dashboard. Requires the workspace owner to be on a plan with AI page features.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace UUID from list_clients' },
        name: { type: 'string', description: 'Internal name for the page (shown in the dashboard, not on the page itself)' },
        vertical: { type: 'string', description: 'Short category label, e.g. "SaaS", "Ecommerce", "Local Services"' },
        html_content: { type: 'string', description: 'Full HTML document for the page. If the user has attached image files, embed them directly: base64-encode each file and inline it as <img src="data:image/png;base64,...">. The server automatically detects any base64 data: image URIs in this HTML, uploads them to permanent storage, and rewrites the src to a real hosted URL — no separate upload tool needed.' },
        prompt: { type: 'string', description: 'Optional: the instruction/brief this page was built from, stored for reference' },
      },
      required: ['workspace_id', 'name', 'vertical', 'html_content'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_page',
    description: 'Fetches a page\'s current content and metadata, including its live HTML, its unpublished draft HTML (if any), and a SplitLab-hosted preview URL a human can open in a browser (they must already be logged in to SplitLab there). If the page backs an A/B test variant, that is called out explicitly — edits to it land in draft only until the variant is republished. IMPORTANT: if draft_html_content (and draft_schema_json) is present, that is the page\'s current state — always call this before update_page and base your next edit on draft_html_content, not html_content, or you will silently revert earlier unsaved changes.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string' } },
      required: ['page_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_page',
    description: 'Edits a page\'s HTML/name/prompt/tags/status. This NEVER writes directly to a live, published page: if the page backs an active A/B test variant, the edit is stored as a draft only (use publish_page or the dashboard\'s "Replace variant" to promote it); if the page is a standalone, unpublished draft, the edit updates that draft in place. html_content you send here must be the FULL replacement document, built on top of get_page\'s draft_html_content when one exists (not html_content) — otherwise this overwrites and loses any earlier unsaved draft edit. The response includes preview_url and draft_preview_url (draft_preview_url is set whenever this edit landed in draft) — always share the relevant one back with the user after editing (draft_preview_url if the page backs a test variant or otherwise has a draft, preview_url for a standalone page with no draft) so they can see exactly what they\'re now editing, whether it was an uploaded HTML page or an AI-generated one, before deciding to publish/replace it live. If this page backs a test variant, its scan_results are regenerated against the edited HTML on every save (draft or live) — call get_test for the linked test to read fresh, verified selectors before setting up a conversion goal. Requires the workspace owner to be on a plan with AI page features.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        name: { type: 'string' },
        html_content: { type: 'string', description: 'Full replacement HTML document. If the user has attached image files, embed them directly: base64-encode each file and inline it as <img src="data:image/png;base64,...">. The server automatically detects any base64 data: image URIs in this HTML, uploads them to permanent storage, and rewrites the src to a real hosted URL — no separate upload tool needed. Build this on top of get_page\'s draft_html_content when one exists, not html_content.' },
        prompt: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['active', 'archived'] },
      },
      required: ['page_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'publish_page',
    description: 'Publishes a standalone page\'s current HTML to its live, SplitLab-hosted URL. This is the one step that makes content actually public — nothing else does. Fails if the page has no built HTML yet.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string' } },
      required: ['page_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'unpublish_page',
    description: 'Takes a published page offline (its URL stops resolving) without deleting it. Reversible by calling publish_page again.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string' } },
      required: ['page_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_page',
    description: 'Soft-deletes a page (reversible — the row is marked deleted and unpublished, not destroyed). Deleting a page that backs a live A/B test variant will break that variant; check get_page first if unsure.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string' } },
      required: ['page_id'],
      additionalProperties: false,
    },
  },

  // Phase 2 (MCP_ROADMAP.md): variants & A/B tests. list_tests/get_test close
  // the discovery gap Phase 1 hit live (no way to answer "how many variants
  // does this test have"); save_page_as_variant/save_page_as_new/replace_variant
  // close the page lifecycle create_page/update_page otherwise dead-end at.
  {
    name: 'list_tests',
    description: 'Lists the A/B tests in a workspace, each with its variants (id, name, traffic_weight, is_control, archived, linked page_id) and conversion goals (id, name, type, is_primary). Call this before any variant/test tool that needs a test_id or variant_id — Claude cannot guess these. Each test also includes test_url — the real, live-traffic link for that test (runs through actual weighted variant assignment, sticky cookies, and conversion tracking, no custom domain needed). This is what to give the user when they ask for "the test link" or want to click through and verify a goal actually fires — NOT a page\'s preview_url, which is an authenticated, untracked raw-HTML view for a logged-in human only and will never register a conversion.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', description: 'Workspace UUID from list_clients' } },
      required: ['workspace_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_test',
    description: 'Fetches one test\'s full detail: status, url_path, every variant (with id, name, traffic_weight, is_control, archived_at, linked page id/name), and every conversion goal (with id). Goal and variant ids returned here must be reused verbatim by update_test_weights/update_test_goals — never invent or regenerate them. Also includes scan_results: { variants: [{ variant_id, elements: [{ type, id, text, selector }] }] } — a pre-verified list of clickable elements (forms/buttons/checkboxes/links) actually present in each HTML variant\'s markup, auto-generated whenever that variant\'s HTML is written. When setting up a conversion goal with update_test_goals or create_test, always take the selector from here for the matching variant_id rather than inventing one by reading HTML yourself — these are checked to actually match an element, a guessed selector is not. A variant with no scan_results entry (or a redirect-type variant, which has no HTML at all) has nothing verified yet — tell the user it needs to be scanned manually in the SplitLab dashboard (the "Scan Page" flow on a live URL) before you can set up a reliable goal for it. Also includes test_url — the real, trackable, live-traffic link for this test (weighted variant assignment, real conversion tracking). Hand this to the user when they want to click through and test a goal themselves, not a page\'s preview_url.',
    inputSchema: {
      type: 'object',
      properties: { test_id: { type: 'string' } },
      required: ['test_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_test',
    description: 'Creates a brand-new A/B test in a workspace, with one or more variants (e.g. an existing standalone page as the Control at 100% traffic, matching the dashboard\'s "Save as a New Test" action). Variant traffic_weights must sum to exactly 100. A page already linked to another test cannot be reused as a variant here. Fails if another ACTIVE test in the workspace already uses the same url_path. If you also want to set up goals here, each linked page gets auto-scanned the moment it\'s attached — call get_test right after this to read scan_results and pull verified selectors from there for update_test_goals, rather than guessing selectors up front in this call.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        name: { type: 'string' },
        url_path: { type: 'string', description: 'Path this test runs on, e.g. "/" or "/pricing"' },
        status: { type: 'string', enum: ['draft', 'active'], description: 'Defaults to active if omitted' },
        variants: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              page_id: { type: 'string', description: 'An existing standalone page not already linked to a test' },
              redirect_url: { type: 'string', description: 'Alternative to page_id: redirect this variant to an external URL' },
              proxy_mode: { type: 'boolean' },
              traffic_weight: { type: 'number', description: '1-100, all variants together must sum to 100' },
              is_control: { type: 'boolean', description: 'First variant is treated as control by default' },
            },
            required: ['name', 'traffic_weight'],
          },
        },
        goals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['form_submit', 'button_click', 'url_reached', 'call_click'] },
              selector: { type: 'string' },
              url_pattern: { type: 'string' },
              is_primary: { type: 'boolean' },
            },
            required: ['name', 'type'],
          },
        },
      },
      required: ['workspace_id', 'name', 'url_path', 'variants'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_page_as_variant',
    description: 'Attaches an existing standalone page (e.g. one just created via create_page) onto a chosen test as a new variant, at 0% traffic. The page must already have built HTML. A page can only ever back one variant — this fails if it\'s already linked to one (use save_page_as_new to fork instead). Does not touch the test\'s existing traffic split. The variant\'s clickable elements get auto-scanned the moment it\'s attached — call get_test afterward to read scan_results if you\'re about to set up a conversion goal on it.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'A standalone page, not already linked to a test' },
        test_id: { type: 'string' },
        name: { type: 'string', description: 'Name for the new variant' },
      },
      required: ['page_id', 'test_id', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_page_as_new',
    description: 'Forks a variant-linked page\'s current draft (or live HTML if no draft) into a brand-new page and wires it into the SAME test as a new variant at 0% traffic. The original variant and every other variant\'s traffic are left untouched — this is the non-destructive alternative to replace_variant. Clears the original page\'s draft afterward. The new variant\'s scan_results are regenerated automatically — call get_test afterward for fresh selectors before setting up goals on it.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Must already be linked to a test variant (check get_page\'s linked_test_variant first)' },
        name: { type: 'string', description: 'Name for the forked variant' },
      },
      required: ['page_id', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_variant',
    description: 'DANGER — promotes a variant-linked page\'s draft onto LIVE immediately: this changes what real visitors see the moment it is called, with no separate confirmation step. Only use this when the user has clearly asked to publish/ship/go-live with the current edit to an existing test variant. For a safer non-destructive option, use save_page_as_new instead. Fails if the page has no pending draft. scan_results for this variant are regenerated against the newly-live HTML — any goal selector set against the old content should be re-checked via get_test afterward, since the markup it pointed at may no longer exist.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string', description: 'Must already be linked to a test variant and have a pending draft' } },
      required: ['page_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'duplicate_variant',
    description: 'Clones a variant (its page\'s HTML, or its redirect/proxy config) into a new variant on the same test, at 0% traffic. Does not copy conversion goals or personalization rules. Use this for "make a copy of variant X to tweak." An HTML clone is freshly scanned under its own variant_id (not copied from the source) — call get_test to read its scan_results once you start editing it.',
    inputSchema: {
      type: 'object',
      properties: { test_id: { type: 'string' }, variant_id: { type: 'string' } },
      required: ['test_id', 'variant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_variant',
    description: 'Adds a fresh (blank, not cloned) variant to an existing test — either HTML you write yourself, or a redirect URL, or proxy mode. The new variant joins at 0% traffic and no existing variant\'s weight is touched — adding a variant never moves traffic off a live page. To actually send it traffic, call update_test_weights afterwards with the full split. (The only exception: on a test with no active variants left, the new one joins at 100%, since something has to carry the traffic.) An HTML variant gets scanned automatically on creation — call get_test to read its scan_results before setting up a conversion goal on it. A redirect/proxy variant has no HTML, so it never gets scan_results — goals on it need a manual scan in the dashboard first.',
    inputSchema: {
      type: 'object',
      properties: {
        test_id: { type: 'string' },
        name: { type: 'string' },
        html_content: { type: 'string', description: 'Full HTML document — creates a new page for this variant' },
        redirect_url: { type: 'string', description: 'Alternative to html_content: redirect visitors to an external URL' },
        proxy_mode: { type: 'boolean', description: 'When redirecting, proxy the destination instead of a browser redirect' },
      },
      required: ['test_id', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'duplicate_test',
    description: 'Duplicates an entire test — every variant and every conversion goal — onto a new url_path, created as draft so it never conflicts with the live test until reviewed and activated.',
    inputSchema: {
      type: 'object',
      properties: {
        test_id: { type: 'string' },
        name: { type: 'string' },
        url_path: { type: 'string', description: 'New path, must not collide with another active test in the workspace' },
      },
      required: ['test_id', 'name', 'url_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_test',
    description: 'Permanently deletes a test and every one of its variants and goals. Pages backing those variants are soft-deleted along with it (recoverable), but the test row itself is hard-deleted and cannot be undone. Use archive_variant instead if you only want to stop a variant from receiving traffic.',
    inputSchema: {
      type: 'object',
      properties: {
        test_id: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true — safety check against accidental deletion' },
      },
      required: ['test_id', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_test_weights',
    description: 'Sets traffic split across a test\'s variants (e.g. 50/50, 80/20). Requires the COMPLETE set of active (non-archived) variant ids and weights summing to exactly 100 — a partial set (e.g. just one variant) is rejected outright, by design, so a "just bump this one variant" request can\'t silently break the split. Call get_test first to get every active variant\'s id.',
    inputSchema: {
      type: 'object',
      properties: {
        test_id: { type: 'string' },
        weights: {
          type: 'array',
          description: 'Every active variant\'s id and its new traffic_weight — must sum to 100',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, traffic_weight: { type: 'number' } },
            required: ['id', 'traffic_weight'],
          },
        },
      },
      required: ['test_id', 'weights'],
      additionalProperties: false,
    },
  },
  {
    name: 'archive_variant',
    description: 'Pulls a variant out of the live traffic split (sets it to 0% and marks it archived) without deleting it — SplitLab\'s equivalent of "remove from the test." Its traffic share is absorbed by the remaining active variants in proportion to what they already hold, so their ratios are preserved and any variant parked at 0% stays at 0% — archiving a variant that was already at 0% moves no traffic at all. Refuses to archive a test\'s last active variant, or a variant that is the only one receiving traffic (there would be nowhere proportional for its share to go — give another variant traffic above 0% first).',
    inputSchema: {
      type: 'object',
      properties: { test_id: { type: 'string' }, variant_id: { type: 'string' } },
      required: ['test_id', 'variant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'unarchive_variant',
    description: 'Restores an archived variant back into the active rotation at 0% traffic, leaving every other variant\'s weight exactly where it is. It receives no traffic until someone deliberately ramps it up with update_test_weights — an old page rejoining a live test must never take real traffic by surprise.',
    inputSchema: {
      type: 'object',
      properties: { test_id: { type: 'string' }, variant_id: { type: 'string' } },
      required: ['test_id', 'variant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'rename_variant',
    description: 'Renames a variant. Does not touch its content, weight, or archive status.',
    inputSchema: {
      type: 'object',
      properties: { test_id: { type: 'string' }, variant_id: { type: 'string' }, name: { type: 'string' } },
      required: ['test_id', 'variant_id', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'promote_to_champion',
    description: 'Makes the given variant the test\'s control/champion (is_control). Only one variant can be control at a time — the previous champion loses the flag automatically. This is a label change only, it does NOT change traffic weights; use update_test_weights separately if you also want to shift traffic. Refuses to promote an archived variant.',
    inputSchema: {
      type: 'object',
      properties: { test_id: { type: 'string' }, variant_id: { type: 'string' } },
      required: ['test_id', 'variant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_test_goals',
    description: 'Replaces a test\'s conversion goals by full diff. To edit or keep an existing goal, pass its id back exactly as returned by get_test/list_tests — omitting a previously-listed goal\'s id here deletes it. Never invent a new id for an existing goal: doing so would orphan its historical event data. Goals with no id are created as new. For form_submit/button_click/call_click goals, call get_test first and take the `selector` from its scan_results for the target variant_id (map scan element type → goal type: form→form_submit, button→button_click, call→call_click) — never write your own guessed selector, it will silently never fire if wrong. url_reached goals use url_pattern instead and don\'t need a selector. If scan_results has no entry for that variant (or it\'s a redirect-type variant with no HTML), tell the user to scan it manually in the dashboard first.',
    inputSchema: {
      type: 'object',
      properties: {
        test_id: { type: 'string' },
        goals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Omit only for a brand-new goal; include verbatim to keep an existing one' },
              name: { type: 'string' },
              type: { type: 'string', enum: ['form_submit', 'button_click', 'url_reached', 'call_click'] },
              selector: { type: 'string' },
              url_pattern: { type: 'string' },
              is_primary: { type: 'boolean' },
              variant_id: { type: 'string', description: 'Optional: scope this goal to one specific variant' },
            },
            required: ['name', 'type', 'is_primary'],
          },
        },
      },
      required: ['test_id', 'goals'],
      additionalProperties: false,
    },
  },

  // Phase 3 (MCP_ROADMAP.md): URL/slug is the one field that takes effect
  // immediately rather than staging as a draft — matches Unbounce's own
  // exception. assign_domain/SEO-OG-fields/redirects/page-groups from that
  // phase are NOT built: none of them map onto anything that exists in this
  // schema today (verified — no domain_id on pages, no SEO columns, no
  // redirect table, no page-group concept), so building them would mean
  // inventing new schema/data model, not wrapping existing logic.
  {
    name: 'set_page_slug',
    description: 'Changes a page\'s URL slug. Takes effect immediately (NOT staged as a draft, unlike content edits) — if the page is already published, its live URL changes the moment this is called. Fails if another page already has that slug.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        slug: { type: 'string', description: 'Lowercase letters, numbers, and hyphens only, e.g. "spring-sale"' },
      },
      required: ['page_id', 'slug'],
      additionalProperties: false,
    },
  },

  // Phase 3 (continued): domain management. Unlike assign_domain (never
  // built — no page->domain link exists in the schema), domains themselves
  // are a real, existing, workspace-scoped feature (Vercel integration,
  // src/app/api/workspaces/[id]/domains/route.ts) — these tools wrap it
  // directly, same pattern as everything else in this file. update_domain
  // (swap the domain string) is intentionally NOT exposed here — it
  // removes+re-adds the domain in Vercel and resets verification, the
  // riskiest of the four operations; use the SplitLab dashboard for that.
  {
    name: 'list_domains',
    description: 'Lists the custom domains configured for a workspace, each with its verification status. Each entry includes dns_instructions.primary — the CNAME record that must be added at the registrar for traffic to actually route to SplitLab, required for every domain, verified or not. For a root/apex domain only (e.g. "example.com", not "offers.example.com"), dns_instructions.root_domain_alternative is also present — an A record that is an ALTERNATIVE to the CNAME, not an addition to it (some registrars reject a CNAME on the root domain; add ONE of the two, never both — a name can\'t have both record types at once). Separately, vercel_verification (when present) is a TXT record Vercel additionally needs to confirm domain ownership — that is NOT a substitute for dns_instructions. If a user asks "what do I still need to add" for an already-registered domain, use this tool and answer from dns_instructions (plus vercel_verification if set), not from memory of an earlier add_domain response.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', description: 'Workspace UUID from list_clients' } },
      required: ['workspace_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_domain',
    description: 'Registers a new custom domain on a workspace with Vercel and creates its SplitLab record. Returns dns_instructions.primary — a CNAME record that must ALWAYS be added at the registrar for the domain to route traffic to SplitLab at all — show this to the user verbatim every time, it is not optional. If this is a root/apex domain (e.g. "example.com", not "offers.example.com"), dns_instructions.root_domain_alternative is also returned: an A record the user should add INSTEAD OF the CNAME if their registrar doesn\'t support a CNAME on the root domain — never tell the user to add both, a name can only have one or the other. Separately (and independently of the above), vercel_verification may also be returned — an extra TXT record Vercel sometimes needs for ownership proof; adding only that TXT record without the CNAME/A record leaves the domain "misconfigured" even though ownership looks fine, which is a common mistake — always give the user the CNAME/A instructions too, not the TXT alone. Then call verify_domain once they confirm the records are in place. Subject to the workspace owner\'s plan domain limit.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        domain: { type: 'string', description: 'The domain or subdomain, e.g. "example.com" or "offers.example.com"' },
      },
      required: ['workspace_id', 'domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify_domain',
    description: 'Checks whether a domain\'s DNS has been correctly pointed at SplitLab and marks it verified if so. This calls Vercel\'s verification API, which is rate-limited to 50 checks/hour per project across ALL of SplitLab\'s workspaces — do not call this in a retry loop; call it once per user request ("check if my domain is verified now"), and if it reports still-pending, tell the user DNS propagation can take a few minutes and to ask again later rather than re-checking immediately yourself. On a still-not-verified result, re-share dns_instructions from this response (dns_instructions.primary CNAME, or for a root domain dns_instructions.root_domain_alternative A record used INSTEAD of the CNAME, never both) rather than re-sending only status.vercel_verification\'s TXT record — a misconfigured result very often means the CNAME/A record itself was never added, which the TXT record alone will not fix.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string' }, domain_id: { type: 'string', description: 'Domain UUID from list_domains' } },
      required: ['workspace_id', 'domain_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_domain',
    description: 'Permanently removes a domain from the workspace and from Vercel. Any test currently serving traffic on this domain will stop resolving for visitors. Not reversible through this tool — the domain would need to be re-added and re-verified from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        domain_id: { type: 'string', description: 'Domain UUID from list_domains' },
        confirm: { type: 'boolean', description: 'Must be true — safety check against accidental deletion' },
      },
      required: ['workspace_id', 'domain_id', 'confirm'],
      additionalProperties: false,
    },
  },

  // Phase 4 (MCP_ROADMAP.md): track results. list_goals/create_goal aren't
  // separate tools — get_test/list_tests (Phase 2) already return every
  // goal's id, and update_test_goals (Phase 2) already covers create/edit —
  // a dedicated list_goals tool would be a pure duplicate of get_test.
  {
    name: 'get_test_stats',
    description: 'Reads an A/B test\'s results: per-variant views/unique visitors/conversions/CVR, statistical confidence vs. the control variant, and which variant (if any) is currently winning. Set include_daily to also get a day-by-day breakdown for charting. Viewers cannot call this — same restriction as the SplitLab dashboard, where analytics is manager/admin only even though other data is viewer-readable.',
    inputSchema: {
      type: 'object',
      properties: {
        test_id: { type: 'string' },
        from: { type: 'string', description: 'Optional start date, YYYY-MM-DD. Omit for all-time.' },
        to: { type: 'string', description: 'Optional end date, YYYY-MM-DD. Omit for all-time.' },
        include_daily: { type: 'boolean', description: 'Also return a day-by-day time series (default false)' },
        variant_id: { type: 'string', description: 'Only used with include_daily: restrict the daily series to one variant instead of all' },
      },
      required: ['test_id'],
      additionalProperties: false,
    },
  },
];

export async function POST(request: NextRequest) {
  let body: JsonRpcRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }

  const { id = null, method, params } = body;

  // Handshake methods don't require auth — a client needs to be able to
  // negotiate the protocol version before it has a token.
  if (method === 'initialize') {
    return NextResponse.json(
      rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    );
  }
  if (method === 'notifications/initialized') {
    return new NextResponse(null, { status: 202 });
  }

  // Everything else requires a valid, unrevoked, unexpired access token that
  // resolves to the same {id, role, plan} shape session.user already has.
  const bearer = extractBearerToken(request.headers.get('authorization'));
  const principal = await resolveMcpPrincipal(bearer);
  if (!principal) {
    return NextResponse.json(rpcError(id, -32001, 'Unauthorized'), {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
    });
  }

  const rate = checkMcpRateLimit(principal.tokenId);
  if (!rate.allowed) {
    return NextResponse.json(rpcError(id, -32002, 'Rate limit exceeded'), {
      status: 429,
      headers: rate.retryAfterSeconds ? { 'Retry-After': String(rate.retryAfterSeconds) } : undefined,
    });
  }

  if (method === 'tools/list') {
    return NextResponse.json(rpcResult(id, { tools: TOOLS }));
  }

  if (method === 'tools/call') {
    const toolName = params?.name as string | undefined;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;

    // Small helpers to keep every case below to the same shape: log, then
    // return either a success or an isError content payload — never throw
    // past this point for an expected (as opposed to a bug) failure, so the
    // catch block below stays reserved for genuine unexpected errors.
    const succeed = async (data: unknown) => {
      await logMcpAction(principal, toolName as string, { status: 'ok' });
      return NextResponse.json(rpcResult(id, toolContent(data)));
    };
    const denyOrFail = async (error: string) => {
      await logMcpAction(principal, toolName as string, { status: 'error', errorMessage: error });
      return NextResponse.json(rpcResult(id, toolContent({ error }, true)));
    };

    try {
      if (toolName === 'whoami') {
        return succeed({ id: principal.id, role: principal.role, plan: principal.plan, scope: principal.scope });
      }

      if (toolName === 'list_clients') {
        const result = await listClientsForUser(principal.id, principal.role);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'list_pages') {
        const workspaceId = args.workspace_id as string | undefined;
        if (!workspaceId) return denyOrFail('workspace_id is required');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: false });
        if (!access.ok) return denyOrFail(access.error);

        const result = await listWorkspacePages(workspaceId);
        if (!result.ok) return denyOrFail(result.error);
        const trimmed = (result.data as Array<Record<string, unknown>>).map((p) => ({
          id: p.id, name: p.name, slug: p.slug, status: p.status,
          is_published: p.is_published, published_url: p.published_url,
          has_draft: Boolean(p.draft_html_content), created_at: p.created_at, updated_at: p.updated_at,
        }));
        return succeed(trimmed);
      }

      if (toolName === 'create_page') {
        const workspaceId = args.workspace_id as string | undefined;
        const name = args.name as string | undefined;
        const vertical = args.vertical as string | undefined;
        const htmlContent = args.html_content as string | undefined;
        if (!workspaceId || !name || !vertical || !htmlContent) {
          return denyOrFail('workspace_id, name, vertical, and html_content are required');
        }

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const planError = await requireAiPagesPlan(principal, workspaceId);
        if (planError) return denyOrFail(planError);

        const result = await createPage({
          workspace_id: workspaceId, name, vertical,
          prompt: (args.prompt as string) ?? null, html_content: htmlContent,
          created_by: principal.id,
        });
        if (!result.ok) return denyOrFail(result.error);
        const page = result.data as { id: string; name: string; slug: string; status: string };
        return succeed({ ...page, preview_url: `${APP_URL}/api/pages/${page.id}/preview` });
      }

      if (toolName === 'get_page') {
        const pageId = args.page_id as string | undefined;
        if (!pageId) return denyOrFail('page_id is required');

        const result = await getPageWithContent(pageId);
        if (!result.ok) return denyOrFail(result.error);
        const page = result.data as Record<string, unknown> & { id: string; workspace_id: string; slug: string | null };

        const access = await requireWorkspaceAccess(principal, page.workspace_id, { write: false });
        if (!access.ok) return denyOrFail(access.error);

        const linkedVariant = await getLinkedVariant(pageId);
        return succeed({
          ...page,
          preview_url: `${APP_URL}/api/pages/${page.id}/preview`,
          draft_preview_url: page.draft_html_content ? `${APP_URL}/api/pages/${page.id}/preview?draft=1` : null,
          linked_test_variant: linkedVariant
            ? { variant_id: linkedVariant.id, variant_name: linkedVariant.name, test_id: linkedVariant.test_id }
            : null,
        });
      }

      if (toolName === 'update_page') {
        const pageId = args.page_id as string | undefined;
        if (!pageId) return denyOrFail('page_id is required');

        const workspaceId = await pageWorkspaceId(pageId);
        if (!workspaceId) return denyOrFail('Not found');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const planError = await requireAiPagesPlan(principal, workspaceId);
        if (planError) return denyOrFail(planError);

        const pageResult = await getPageWithContent(pageId);
        if (!pageResult.ok) return denyOrFail(pageResult.error);
        const pageMeta = pageResult.data as { html_url: string | null; schema_json: Record<string, unknown> | null };

        const result = await updatePageDraftOrLive(pageId, pageMeta, {
          name: args.name as string | undefined,
          html_content: args.html_content as string | undefined,
          prompt: args.prompt as string | undefined,
          tags: args.tags as string[] | undefined,
          status: args.status as 'active' | 'archived' | undefined,
          // Always draft — see updatePageDraftOrLive's doc comment. This tool
          // never has a code path that writes a live variant's served HTML.
          draft: true,
        });
        if (!result.ok) return denyOrFail(result.error);
        const updatedPage = result.data as { id: string; draft_html_content: string | null };
        return succeed({
          ...updatedPage,
          preview_url: `${APP_URL}/api/pages/${updatedPage.id}/preview`,
          draft_preview_url: updatedPage.draft_html_content ? `${APP_URL}/api/pages/${updatedPage.id}/preview?draft=1` : null,
        });
      }

      if (toolName === 'publish_page') {
        const pageId = args.page_id as string | undefined;
        if (!pageId) return denyOrFail('page_id is required');

        const pageResult = await getPageWithContent(pageId);
        if (!pageResult.ok) return denyOrFail(pageResult.error);
        const page = pageResult.data as { workspace_id: string; html_url: string | null; html_content: string | null; slug: string | null; status: string };

        const access = await requireWorkspaceAccess(principal, page.workspace_id, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await publishPage(pageId, page);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'unpublish_page') {
        const pageId = args.page_id as string | undefined;
        if (!pageId) return denyOrFail('page_id is required');

        const workspaceId = await pageWorkspaceId(pageId);
        if (!workspaceId) return denyOrFail('Not found');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await unpublishPage(pageId);
        if (!result.ok) return denyOrFail(result.error);
        return succeed({ success: true });
      }

      if (toolName === 'delete_page') {
        const pageId = args.page_id as string | undefined;
        if (!pageId) return denyOrFail('page_id is required');

        const workspaceId = await pageWorkspaceId(pageId);
        if (!workspaceId) return denyOrFail('Not found');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await softDeletePage(pageId);
        if (!result.ok) return denyOrFail(result.error);
        return succeed({ success: true });
      }

      if (toolName === 'list_tests') {
        const workspaceId = args.workspace_id as string | undefined;
        if (!workspaceId) return denyOrFail('workspace_id is required');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: false });
        if (!access.ok) return denyOrFail(access.error);

        const result = await listWorkspaceTests(workspaceId);
        if (!result.ok) return denyOrFail(result.error);
        const withUrls = (result.data as { id: string; name: string; url_path: string }[]).map((t) => ({ ...t, test_url: buildTestUrl(t) }));
        return succeed(withUrls);
      }

      if (toolName === 'get_test') {
        const testId = args.test_id as string | undefined;
        if (!testId) return denyOrFail('test_id is required');

        const access = await requireTestAccess(principal, testId, { write: false });
        if (!access.ok) return denyOrFail(access.error);

        const result = await getTestDetail(testId);
        if (!result.ok) return denyOrFail(result.error);
        const test = result.data as { id: string; name: string; url_path: string };
        return succeed({ ...test, test_url: buildTestUrl(test) });
      }

      if (toolName === 'create_test') {
        const workspaceId = args.workspace_id as string | undefined;
        const name = args.name as string | undefined;
        const urlPath = args.url_path as string | undefined;
        const variants = args.variants as {
          name: string; page_id?: string; redirect_url?: string; proxy_mode?: boolean;
          traffic_weight: number; is_control?: boolean;
        }[] | undefined;
        if (!workspaceId || !name || !urlPath || !variants || variants.length === 0) {
          return denyOrFail('workspace_id, name, url_path, and at least one variant are required');
        }

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await createTest(
          {
            workspace_id: workspaceId,
            name,
            url_path: urlPath,
            status: args.status as 'draft' | 'active' | undefined,
            variants,
            goals: args.goals as {
              name: string; type: 'form_submit' | 'button_click' | 'url_reached' | 'call_click';
              selector?: string; url_pattern?: string; is_primary?: boolean;
            }[] | undefined,
          },
          principal.id,
          principal.role
        );
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'save_page_as_variant') {
        const pageId = args.page_id as string | undefined;
        const testId = args.test_id as string | undefined;
        const name = args.name as string | undefined;
        if (!pageId || !testId || !name) return denyOrFail('page_id, test_id, and name are required');

        const pageResult = await getPageWithContent(pageId);
        if (!pageResult.ok) return denyOrFail(pageResult.error);
        const page = pageResult.data as { workspace_id: string; html_content: string | null; html_url: string | null };

        const pageAccess = await requireWorkspaceAccess(principal, page.workspace_id, { write: true });
        if (!pageAccess.ok) return denyOrFail(pageAccess.error);

        const testAccess = await requireTestAccess(principal, testId, { write: true });
        if (!testAccess.ok) return denyOrFail(testAccess.error);

        const result = await attachPageAsVariant(pageId, page, testId, testAccess.workspaceId, name, principal.role);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'save_page_as_new') {
        const pageId = args.page_id as string | undefined;
        const name = args.name as string | undefined;
        if (!pageId || !name) return denyOrFail('page_id and name are required');

        const pageResult = await getPageWithContent(pageId);
        if (!pageResult.ok) return denyOrFail(pageResult.error);
        const page = pageResult.data as {
          workspace_id: string; vertical: string | null; html_content: string | null;
          schema_json: Record<string, unknown> | null; draft_html_content: string | null; draft_schema_json: Record<string, unknown> | null;
        };

        const access = await requireWorkspaceAccess(principal, page.workspace_id, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await forkPageAsNewVariant(pageId, page, name, principal.role);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'replace_variant') {
        const pageId = args.page_id as string | undefined;
        if (!pageId) return denyOrFail('page_id is required');

        const pageResult = await getPageWithContent(pageId);
        if (!pageResult.ok) return denyOrFail(pageResult.error);
        const page = pageResult.data as { workspace_id: string; html_url: string | null; draft_html_content: string | null; draft_schema_json: Record<string, unknown> | null };

        const access = await requireWorkspaceAccess(principal, page.workspace_id, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await replaceVariantLive(pageId, page);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'duplicate_variant') {
        const testId = args.test_id as string | undefined;
        const variantId = args.variant_id as string | undefined;
        if (!testId || !variantId) return denyOrFail('test_id and variant_id are required');

        const access = await requireTestAccess(principal, testId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await duplicateVariant(testId, variantId, access.workspaceId, principal.role);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'create_variant') {
        const testId = args.test_id as string | undefined;
        const name = args.name as string | undefined;
        if (!testId || !name) return denyOrFail('test_id and name are required');

        const access = await requireTestAccess(principal, testId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await createVariant(testId, access.workspaceId, principal.role, {
          name,
          html_content: args.html_content as string | undefined,
          redirect_url: args.redirect_url as string | undefined,
          proxy_mode: args.proxy_mode as boolean | undefined,
        });
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'duplicate_test') {
        const testId = args.test_id as string | undefined;
        const name = args.name as string | undefined;
        const urlPath = args.url_path as string | undefined;
        if (!testId || !name || !urlPath) return denyOrFail('test_id, name, and url_path are required');

        const access = await requireTestAccess(principal, testId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await duplicateTest(testId, access.workspaceId, name, urlPath);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'delete_test') {
        const testId = args.test_id as string | undefined;
        const confirm = args.confirm as boolean | undefined;
        if (!testId) return denyOrFail('test_id is required');
        if (confirm !== true) return denyOrFail('confirm must be true to delete a test — this is irreversible');

        const access = await requireTestAccess(principal, testId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await deleteTest(testId);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'update_test_weights') {
        const testId = args.test_id as string | undefined;
        const weights = args.weights as { id: string; traffic_weight: number }[] | undefined;
        if (!testId || !weights) return denyOrFail('test_id and weights are required');

        const access = await requireTestAccess(principal, testId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const testResult = await getTestDetail(testId);
        if (!testResult.ok) return denyOrFail(testResult.error);
        const testRow = testResult.data as TestMeta & { test_variants: { id: string; archived_at: string | null }[] };

        const activeIds = new Set(testRow.test_variants.filter((v) => !v.archived_at).map((v) => v.id));
        const providedIds = new Set(weights.map((w) => w.id));
        const setsMatch = activeIds.size === providedIds.size && Array.from(activeIds).every((vid) => providedIds.has(vid));
        if (!setsMatch) {
          return denyOrFail('weights must include exactly the full set of active (non-archived) variant ids, summing to 100 — partial updates are rejected. Call get_test first to see every active variant id.');
        }

        const result = await updateTest(testId, testRow, { weights });
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'archive_variant' || toolName === 'unarchive_variant') {
        const testId = args.test_id as string | undefined;
        const variantId = args.variant_id as string | undefined;
        if (!testId || !variantId) return denyOrFail('test_id and variant_id are required');

        const access = await requireTestAccess(principal, testId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const testResult = await getTestDetail(testId);
        if (!testResult.ok) return denyOrFail(testResult.error);
        const testRow = testResult.data as TestMeta;

        const result = await updateTest(testId, testRow, toolName === 'archive_variant' ? { archive_variant_id: variantId } : { unarchive_variant_id: variantId });
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'rename_variant') {
        const testId = args.test_id as string | undefined;
        const variantId = args.variant_id as string | undefined;
        const name = args.name as string | undefined;
        if (!testId || !variantId || !name) return denyOrFail('test_id, variant_id, and name are required');

        const access = await requireTestAccess(principal, testId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const testResult = await getTestDetail(testId);
        if (!testResult.ok) return denyOrFail(testResult.error);
        const testRow = testResult.data as TestMeta;

        const result = await updateTest(testId, testRow, { variant_updates: [{ id: variantId, name }] });
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'promote_to_champion') {
        const testId = args.test_id as string | undefined;
        const variantId = args.variant_id as string | undefined;
        if (!testId || !variantId) return denyOrFail('test_id and variant_id are required');

        const access = await requireTestAccess(principal, testId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await promoteToChampion(testId, variantId);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'update_test_goals') {
        const testId = args.test_id as string | undefined;
        const goals = args.goals as import('@/lib/services/tests').GoalInput[] | undefined;
        if (!testId || !goals) return denyOrFail('test_id and goals are required');

        const access = await requireTestAccess(principal, testId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const testResult = await getTestDetail(testId);
        if (!testResult.ok) return denyOrFail(testResult.error);
        const testRow = testResult.data as TestMeta;

        const result = await updateTest(testId, testRow, { goals });
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'set_page_slug') {
        const pageId = args.page_id as string | undefined;
        const slug = args.slug as string | undefined;
        if (!pageId || !slug) return denyOrFail('page_id and slug are required');

        const workspaceId = await pageWorkspaceId(pageId);
        if (!workspaceId) return denyOrFail('Not found');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await setPageSlug(pageId, slug);
        if (!result.ok) return denyOrFail(result.error);

        // Immediate-effect field — old and new /pages/[slug] paths must both
        // stop serving stale cached HTML, same as unpublish/delete's own
        // revalidatePath call.
        if (result.data.old_slug) revalidatePath(`/pages/${result.data.old_slug}`);
        revalidatePath(`/pages/${result.data.slug}`);

        return succeed(result.data);
      }

      if (toolName === 'list_domains') {
        const workspaceId = args.workspace_id as string | undefined;
        if (!workspaceId) return denyOrFail('workspace_id is required');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: false });
        if (!access.ok) return denyOrFail(access.error);

        const result = await listDomains(workspaceId);
        if (!result.ok) return denyOrFail(result.error);
        // dns_instructions is computed here, not stored on the row (see
        // buildDnsInstructions's doc comment) — always attach it so a
        // troubleshooting call ("what record do I still need?") on an
        // already-added domain gets the same routing instructions add_domain
        // returns up front, not just the conditional ownership TXT.
        // root_domain_alternative is an ALTERNATIVE to primary, not an
        // addition — never present both as "add these."
        const withInstructions = (result.data as { domain: string; cname_target: string | null }[]).map((d) => ({
          ...d, dns_instructions: buildDnsInstructions(d.domain, d.cname_target),
        }));
        return succeed(withInstructions);
      }

      if (toolName === 'add_domain') {
        const workspaceId = args.workspace_id as string | undefined;
        const domain = args.domain as string | undefined;
        if (!workspaceId || !domain) return denyOrFail('workspace_id and domain are required');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await addDomain(workspaceId, domain, principal.role);
        if (!result.ok) return denyOrFail(result.error);
        const created = result.data as { domain: string; cname_target: string | null };
        // dns_instructions.primary (CNAME) always routes traffic and is
        // always required; root_domain_alternative (A record), when present,
        // is an alternative to primary for root domains, not an addition —
        // see buildDnsInstructions's doc comment. Distinct from
        // vercel_verification's TXT record, which only appears when Vercel
        // needs separate ownership proof.
        return succeed({ ...created, dns_instructions: buildDnsInstructions(created.domain, created.cname_target) });
      }

      if (toolName === 'verify_domain') {
        const workspaceId = args.workspace_id as string | undefined;
        const domainId = args.domain_id as string | undefined;
        if (!workspaceId || !domainId) return denyOrFail('workspace_id and domain_id are required');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await verifyDomain(workspaceId, domainId);
        if (!result.ok) return denyOrFail(result.error);
        const verifyData = result.data as { domain: string; verified: boolean };
        return succeed({ ...verifyData, dns_instructions: buildDnsInstructions(verifyData.domain, null) });
      }

      if (toolName === 'delete_domain') {
        const workspaceId = args.workspace_id as string | undefined;
        const domainId = args.domain_id as string | undefined;
        const confirm = args.confirm as boolean | undefined;
        if (!workspaceId || !domainId) return denyOrFail('workspace_id and domain_id are required');
        if (confirm !== true) return denyOrFail('confirm must be true to delete a domain — this is irreversible through this tool');

        const access = await requireWorkspaceAccess(principal, workspaceId, { write: true });
        if (!access.ok) return denyOrFail(access.error);

        const result = await deleteDomain(workspaceId, domainId);
        if (!result.ok) return denyOrFail(result.error);
        return succeed(result.data);
      }

      if (toolName === 'get_test_stats') {
        const testId = args.test_id as string | undefined;
        if (!testId) return denyOrFail('test_id is required');

        // write:false only checks membership, not viewer-403 — analytics is
        // restricted beyond the normal "viewers can read" rule (matches
        // GET /api/tests/[id]/analytics and /reporting exactly), so the
        // viewer rejection is enforced explicitly here rather than relying
        // on requireTestAccess's write-gated behavior.
        const access = await requireTestAccess(principal, testId, { write: false });
        if (!access.ok) return denyOrFail(access.error);
        if (access.role === 'viewer') return denyOrFail('Forbidden — analytics is not available to viewer-role connections');

        const from = (args.from as string | undefined) ?? null;
        const to = (args.to as string | undefined) ?? null;

        const summaryResult = await getTestAnalytics(testId, { from, to });
        if (!summaryResult.ok) return denyOrFail(summaryResult.error);

        if (!args.include_daily) {
          return succeed(summaryResult.data);
        }

        const dailyResult = await getTestDailyStats(testId, { from, to, variantId: (args.variant_id as string | undefined) ?? null });
        if (!dailyResult.ok) return denyOrFail(dailyResult.error);

        return succeed({ summary: summaryResult.data, daily: dailyResult.data });
      }

      return NextResponse.json(rpcError(id, -32601, `Unknown tool: ${toolName}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[MCP]', toolName, err);
      await logMcpAction(principal, toolName ?? 'unknown', { status: 'error', errorMessage: message });
      return NextResponse.json(rpcResult(id, toolContent({ error: 'Tool execution failed' }, true)));
    }
  }

  return NextResponse.json(rpcError(id, -32601, `Unknown method: ${method}`), { status: 400 });
}

// Some MCP clients probe GET to establish an SSE stream. Only the stateless
// POST transport is supported for now — respond with a clear 405 instead of
// hanging a connection open.
export async function GET() {
  return NextResponse.json(
    { error: 'This MCP server only supports the stateless HTTP POST transport.' },
    { status: 405 }
  );
}
