import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase-server';
import { confidencePercent, findWinner } from '@/lib/stats';
import { resolveApiPrincipal } from '@/lib/api-key-auth';
import { checkRateLimit } from '@/lib/mcp/rate-limit';
import { isBotRequest } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/v1/clients/leads — reporting API: every client with its lead and
 * conversion totals, broken down to variant level, plus the raw form
 * submissions.
 *
 * NO CORS HEADERS, deliberately. The v1 credential is a single env key that can
 * read every client's contact records, so a browser must not be able to hold
 * it. Omitting CORS makes a direct browser call fail by construction instead of
 * relying on the consumer to do the right thing. If a browser-facing version is
 * ever needed, it needs per-user keys first, not a CORS header.
 */

const MAX_ROWS = 1000;

const querySchema = z.object({
  from:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  to:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  client_id:    z.string().uuid().nullable(),
  cursor:       z.string().max(512).nullable(),
  summary:      z.boolean(),
  include_bots: z.boolean(),
});

/** Opaque bookmark: the last row's (submitted_at, id). Base64url so nobody
 *  builds logic on its internals — the shape is ours to change. */
function encodeCursor(submittedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: submittedAt, i: id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { t: string; i: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.t !== 'string' || typeof parsed?.i !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.t))) return null;
    return { t: parsed.t, i: parsed.i };
  } catch {
    return null;
  }
}

function fail(error: string, message: string, status: number, extra?: Record<string, string>) {
  return NextResponse.json({ error, message }, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
}

/** One row of the flattened RPC output. */
interface ReportRow {
  client_id: string; client_name: string; client_slug: string; client_status: string; client_created_at: string;
  workspace_id: string | null; workspace_name: string | null; workspace_slug: string | null;
  test_id: string | null; test_name: string | null; test_url_path: string | null; test_status: string | null; test_created_at: string | null;
  variant_id: string | null; variant_name: string | null; is_control: boolean | null; traffic_weight: number | null;
  views: number; unique_visitors: number; conversions: number; goal_hits: number;
  leads: number; bot_leads: number; last_lead_at: string | null;
  test_leads: number; test_bot_leads: number; test_last_lead_at: string | null;
}

export async function GET(request: NextRequest) {
  const principal = resolveApiPrincipal(request.headers.get('authorization'));
  if (!principal) {
    return fail('invalid_token', 'API key is missing, invalid, or revoked.', 401);
  }

  const rl = checkRateLimit(`apiv1:${principal.keyId}`, 60);
  if (!rl.allowed) {
    return fail('rate_limited', 'Too many requests. Retry shortly.', 429, {
      'Retry-After': String(rl.retryAfterSeconds ?? 60),
    });
  }

  const sp = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    from:         sp.get('from'),
    to:           sp.get('to'),
    client_id:    sp.get('client_id'),
    cursor:       sp.get('cursor'),
    summary:      sp.get('summary') === '1',
    include_bots: sp.get('include_bots') === '1',
  });

  if (!parsed.success) {
    return fail('invalid_request', 'Check from/to (YYYY-MM-DD), client_id (uuid), and cursor.', 400);
  }
  const q = parsed.data;

  // Inclusive day bounds. `to` covers the whole day, otherwise "to=today"
  // would silently drop everything submitted after midnight.
  const fromIso = q.from ? `${q.from}T00:00:00.000Z` : null;
  const toIso   = q.to   ? `${q.to}T23:59:59.999Z`   : null;
  if (fromIso && toIso && fromIso > toIso) {
    return fail('invalid_request', '`from` is after `to`.', 400);
  }

  // Scope. 'all' today (single internal key); once per-user keys land this is
  // already an array and nothing else here changes.
  let clientIds: string[] | null = principal.clientIds === 'all' ? null : principal.clientIds;
  if (q.client_id) {
    if (clientIds && !clientIds.includes(q.client_id)) {
      return fail('forbidden', 'This key cannot read that client.', 403);
    }
    clientIds = [q.client_id];
  }

  const { data: rpcRows, error: rpcError } = await db.rpc('client_leads_report', {
    p_client_ids:   clientIds,
    p_from:         fromIso,
    p_to:           toIso,
    p_include_bots: q.include_bots,
  });

  if (rpcError) {
    console.error('[api/v1/clients/leads] rpc error', rpcError);
    return fail('server_error', 'Failed to build report.', 500);
  }

  const clients = buildTree((rpcRows ?? []) as ReportRow[]);

  const totals = clients.reduce(
    (acc, c) => ({
      clients: acc.clients + 1,
      leads: acc.leads + c.leads,
      conversions: acc.conversions + c.conversions,
      views: acc.views + c.views,
    }),
    { clients: 0, leads: 0, conversions: 0, views: 0 }
  );

  const body: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    range: { from: q.from ?? null, to: q.to ?? null },
    totals,
    clients,
  };

  // Raw submissions. Skipped entirely on summary=1 — no query runs at all,
  // rather than running one and discarding it.
  if (!q.summary) {
    const rows = await fetchRows({
      clientIds,
      fromIso,
      toIso,
      cursor: q.cursor ? decodeCursor(q.cursor) : null,
      cursorRaw: q.cursor,
      includeBots: q.include_bots,
    });
    if ('error' in rows) return fail(rows.error, rows.message, rows.status);
    body.rows = rows.rows;
    body.next_cursor = rows.nextCursor;
  }

  return NextResponse.json(body, {
    headers: {
      // Contains names, emails and phone numbers — never cached by a proxy.
      'Cache-Control': 'no-store',
    },
  });
}

// ── Tree assembly ──────────────────────────────────────────────────────────

interface VariantNode {
  id: string; name: string; is_control: boolean; traffic_weight: number;
  views: number; unique_visitors: number; conversions: number; goal_hits: number;
  cvr: number; leads: number; confidence: number | null; is_winner: boolean;
}

/**
 * Folds the flat RPC output into clients → workspaces → tests → variants.
 *
 * Test/workspace/client lead totals come from the RPC's test_leads column, NOT
 * from summing the variant rows: a lead whose variant was deleted has a null
 * variant_id and would vanish from a bottom-up sum. Views and conversions do
 * roll up from variants, because events.variant_id is NOT NULL.
 */
function buildTree(rows: ReportRow[]) {
  const clients = new Map<string, ReturnType<typeof newClient>>();

  function newClient(r: ReportRow) {
    return {
      id: r.client_id, name: r.client_name, slug: r.client_slug, status: r.client_status,
      created_at: r.client_created_at,
      leads: 0, bot_leads_excluded: 0, conversions: 0, views: 0, unique_visitors: 0,
      last_lead_at: null as string | null,
      workspaces: new Map<string, {
        id: string; name: string; slug: string;
        leads: number; bot_leads_excluded: number; conversions: number; views: number; unique_visitors: number;
        tests: Map<string, {
          id: string; name: string; url_path: string; status: string; created_at: string;
          leads: number; bot_leads_excluded: number; conversions: number; views: number; unique_visitors: number;
          last_lead_at: string | null;
          variants: VariantNode[];
        }>;
      }>(),
    };
  }

  for (const r of rows) {
    if (!clients.has(r.client_id)) clients.set(r.client_id, newClient(r));
    const c = clients.get(r.client_id)!;

    // A client with no workspaces still belongs in the report, at zero.
    if (!r.workspace_id) continue;
    if (!c.workspaces.has(r.workspace_id)) {
      c.workspaces.set(r.workspace_id, {
        id: r.workspace_id, name: r.workspace_name ?? '', slug: r.workspace_slug ?? '',
        leads: 0, bot_leads_excluded: 0, conversions: 0, views: 0, unique_visitors: 0,
        tests: new Map(),
      });
    }
    const w = c.workspaces.get(r.workspace_id)!;

    if (!r.test_id) continue;
    const firstSightingOfTest = !w.tests.has(r.test_id);
    if (firstSightingOfTest) {
      w.tests.set(r.test_id, {
        id: r.test_id, name: r.test_name ?? '', url_path: r.test_url_path ?? '',
        status: r.test_status ?? '', created_at: r.test_created_at ?? '',
        leads: Number(r.test_leads), bot_leads_excluded: Number(r.test_bot_leads),
        conversions: 0, views: 0, unique_visitors: 0,
        last_lead_at: r.test_last_lead_at,
        variants: [],
      });
      // Lead totals are per-test and repeat on every variant row — add them
      // once, on first sighting, or a 3-variant test would triple its leads.
      w.leads += Number(r.test_leads);
      w.bot_leads_excluded += Number(r.test_bot_leads);
      c.leads += Number(r.test_leads);
      c.bot_leads_excluded += Number(r.test_bot_leads);
      if (r.test_last_lead_at && (!c.last_lead_at || r.test_last_lead_at > c.last_lead_at)) {
        c.last_lead_at = r.test_last_lead_at;
      }
    }
    const t = w.tests.get(r.test_id)!;

    if (!r.variant_id) continue;
    const views = Number(r.views);
    const uniqueVisitors = Number(r.unique_visitors);
    const conversions = Number(r.conversions);

    t.variants.push({
      id: r.variant_id,
      name: r.variant_name ?? '',
      is_control: r.is_control ?? false,
      traffic_weight: r.traffic_weight ?? 0,
      views,
      unique_visitors: uniqueVisitors,
      conversions,
      goal_hits: Number(r.goal_hits),
      // Same denominator the dashboard uses: unique visitors, not raw
      // pageviews. A reload is not a second trial.
      cvr: uniqueVisitors > 0 ? conversions / uniqueVisitors : 0,
      leads: Number(r.leads),
      confidence: null,
      is_winner: false,
    });

    t.views += views;
    t.unique_visitors += uniqueVisitors;
    t.conversions += conversions;
    w.views += views;
    w.unique_visitors += uniqueVisitors;
    w.conversions += conversions;
    c.views += views;
    c.unique_visitors += uniqueVisitors;
    c.conversions += conversions;
  }

  // Significance per test, computed exactly as /api/tests/[id]/analytics does.
  return Array.from(clients.values()).map((c) => ({
    ...c,
    workspaces: Array.from(c.workspaces.values()).map((w) => ({
      ...w,
      tests: Array.from(w.tests.values()).map((t) => {
        const control = t.variants.find((v) => v.is_control) ?? t.variants[0];
        if (control) {
          for (const v of t.variants) {
            if (v.id === control.id) continue;
            v.confidence = confidencePercent(
              control.unique_visitors, control.conversions,
              v.unique_visitors, v.conversions
            );
          }
          const winnerId = findWinner(
            t.variants.map((v) => ({ id: v.id, views: v.unique_visitors, conversions: v.conversions }))
          );
          for (const v of t.variants) v.is_winner = v.id === winnerId;
        }
        return t;
      }),
    })),
  }));
}

// ── Raw submissions ────────────────────────────────────────────────────────

interface RowsResult {
  rows: unknown[];
  nextCursor: string | null;
}

async function fetchRows(opts: {
  clientIds: string[] | null;
  fromIso: string | null;
  toIso: string | null;
  cursor: { t: string; i: string } | null;
  cursorRaw: string | null;
  includeBots: boolean;
}): Promise<RowsResult | { error: string; message: string; status: number }> {
  if (opts.cursorRaw && !opts.cursor) {
    return { error: 'invalid_cursor', message: 'Cursor is malformed. Restart from the first page.', status: 400 };
  }

  // Scope leads by resolving the caller's clients down to test ids. With the
  // unscoped internal key this is skipped entirely rather than materialising
  // every test id in the platform just to filter by all of them.
  let testIds: string[] | null = null;
  if (opts.clientIds) {
    const { data: ws } = await db.from('workspaces').select('id').in('client_id', opts.clientIds);
    const wsIds = (ws ?? []).map((w) => w.id);
    if (wsIds.length === 0) return { rows: [], nextCursor: null };
    const { data: tests } = await db.from('tests').select('id').in('workspace_id', wsIds);
    testIds = (tests ?? []).map((t) => t.id);
    if (testIds.length === 0) return { rows: [], nextCursor: null };
  }

  let query = db
    .from('form_leads')
    .select('id, submitted_at, test_id, variant_id, user_agent, form_fields, extra_params, page_url, page_title, ip_address, utm_source, utm_medium, utm_campaign, utm_content, utm_term, gclid, fbclid, tests(id, name, workspace_id, workspaces(id, name, client_id, clients(id, name)))')
    .order('submitted_at', { ascending: false })
    .order('id', { ascending: false })
    // One extra row is the "is there more?" probe — cheaper and more reliable
    // than a second COUNT query, and it never lies about a boundary page.
    .limit(MAX_ROWS + 1);

  if (testIds) query = query.in('test_id', testIds);
  if (opts.fromIso) query = query.gte('submitted_at', opts.fromIso);
  if (opts.toIso) query = query.lte('submitted_at', opts.toIso);

  if (opts.cursor) {
    // Keyset, not OFFSET: offsets get slower every page and shift under you
    // when new leads arrive mid-walk, duplicating or skipping rows.
    query = query.or(
      // Quoted: an ISO timestamp contains ':' and '.', which are PostgREST
      // filter syntax characters.
      `submitted_at.lt."${opts.cursor.t}",and(submitted_at.eq."${opts.cursor.t}",id.lt.${opts.cursor.i})`
    );
  }

  const { data, error } = await query;
  if (error) {
    console.error('[api/v1/clients/leads] rows error', error);
    return { error: 'server_error', message: 'Failed to load leads.', status: 500 };
  }

  type LeadRow = {
    id: string; submitted_at: string; test_id: string; variant_id: string | null;
    user_agent: string | null; form_fields: Record<string, string> | null;
    extra_params: Record<string, string> | null;
    page_url: string | null; page_title: string | null; ip_address: string | null;
    utm_source: string | null; utm_medium: string | null; utm_campaign: string | null;
    utm_content: string | null; utm_term: string | null; gclid: string | null; fbclid: string | null;
    tests: { id: string; name: string; workspaces: { id: string; name: string; clients: { id: string; name: string } | null } | null } | null;
  };

  const fetched = (data ?? []) as unknown as LeadRow[];

  // hasMore and the cursor are derived from the UNFILTERED page, before bots
  // are dropped. Filtering first would let a page of mostly-bot rows come back
  // short, read as "fewer than the limit, so we're done", and end the walk
  // early — silently truncating the caller's export. So the cursor always
  // advances by what the database actually returned, and bot filtering only
  // ever makes an individual page smaller, never shorter than the truth.
  const hasMore = fetched.length > MAX_ROWS;
  const pageRaw = hasMore ? fetched.slice(0, MAX_ROWS) : fetched;

  // Classified from the stored user agent at read time — the same derivation
  // /api/tests/[id]/form-leads uses, so the API and the dashboard agree about
  // which rows are junk. Never a stored column.
  const page = opts.includeBots ? pageRaw : pageRaw.filter((r) => !isBotRequest(r.user_agent));

  // Variant names in one lookup rather than a join — form_leads.variant_id is
  // nullable, and an inner join through it would drop orphaned leads entirely.
  const variantIds = Array.from(new Set(page.map((r) => r.variant_id).filter((v): v is string => !!v)));
  const variantNames = new Map<string, string>();
  if (variantIds.length > 0) {
    const { data: variants } = await db.from('test_variants').select('id, name').in('id', variantIds);
    for (const v of variants ?? []) variantNames.set(v.id, v.name);
  }

  const rows = page.map((r) => ({
    id: r.id,
    submitted_at: r.submitted_at,
    client: r.tests?.workspaces?.clients
      ? { id: r.tests.workspaces.clients.id, name: r.tests.workspaces.clients.name }
      : null,
    workspace: r.tests?.workspaces ? { id: r.tests.workspaces.id, name: r.tests.workspaces.name } : null,
    test: r.tests ? { id: r.tests.id, name: r.tests.name } : null,
    variant: r.variant_id ? { id: r.variant_id, name: variantNames.get(r.variant_id) ?? null } : null,
    // Free-form: keys are whatever that form actually had. Treat as a
    // dictionary, never a fixed schema.
    form_fields: r.form_fields ?? {},
    utm: {
      utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign,
      utm_content: r.utm_content, utm_term: r.utm_term, gclid: r.gclid, fbclid: r.fbclid,
    },
    extra_params: r.extra_params ?? {},
    page_url: r.page_url,
    page_title: r.page_title,
    ip_address: r.ip_address,
    is_bot: isBotRequest(r.user_agent),
  }));

  // Cursor from the unfiltered page — see the hasMore note above.
  const last = pageRaw[pageRaw.length - 1];
  return {
    rows,
    nextCursor: hasMore && last ? encodeCursor(last.submitted_at, last.id) : null,
  };
}
