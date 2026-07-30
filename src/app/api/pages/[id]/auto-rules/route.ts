import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

// UTM Personalization V2 pivot (2026-07-30, refined 2026-07-31 "PIVOT 3").
// See docs/utm-personalization-v2-automation.md. User-defined rule templates:
// an ordered list of per-field rows (AND'd together). Each row is either a
// literal filter (personalize=false, look_for is a literal value matched
// case-insensitive/contains) or an AI-judged category (personalize=true,
// look_for is a loose description, instructions guide content generation).
// No exact values are pre-declared for personalize rows — the background
// cron judges incoming values against look_for via AI.

const MAX_RULES_PER_PAGE = 200;
const MAX_ROWS_PER_RULE = 5;

const LEGACY_UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const EXTRA_ID_PARAMS = ['h_ad_id', 'ad_id', 'adset_id', 'campaign_id', 'creative_id', 'placement_id'];

function isAllowedField(name: string): boolean {
  if (LEGACY_UTM_PARAMS.includes(name)) return true;
  if (EXTRA_ID_PARAMS.includes(name)) return true;
  if (name.indexOf('hsa_') === 0) return true;
  return false;
}

export interface AutoRuleRow {
  field: string;
  look_for: string;
  personalize: boolean;
  instructions?: string;
}

async function authorize(pageId: string) {
  const session = await getServerSession(authOptions);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  const { data: page } = await db.from('pages').select('workspace_id').eq('id', pageId).single();
  if (!page) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };

  return { wsRole };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;

  const { data, error } = await db
    .from('utm_auto_rules')
    .select('*')
    .eq('page_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rules: data ?? [] });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;
  if (auth.wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json();
  const rawRows = body.rows as unknown[] | undefined;

  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return NextResponse.json({ error: 'Add at least one field row.' }, { status: 400 });
  }
  if (rawRows.length > MAX_ROWS_PER_RULE) {
    return NextResponse.json({ error: `Maximum ${MAX_ROWS_PER_RULE} rows per rule.` }, { status: 400 });
  }

  const rows: AutoRuleRow[] = [];
  for (const raw of rawRows) {
    if (typeof raw !== 'object' || raw === null) {
      return NextResponse.json({ error: 'Each row must be an object.' }, { status: 400 });
    }
    const r = raw as Record<string, unknown>;
    const field = r.field;
    const lookFor = typeof r.look_for === 'string' ? r.look_for.trim().slice(0, 500) : '';
    const personalize = r.personalize === true;
    const instructions = typeof r.instructions === 'string' ? r.instructions.trim().slice(0, 500) : '';

    if (typeof field !== 'string' || !isAllowedField(field)) {
      return NextResponse.json({ error: `"${field}" is not a recognized tracking parameter.` }, { status: 400 });
    }
    if (lookFor.length < 2) {
      return NextResponse.json({ error: `Describe what to look for in "${field}" — this guides matching.` }, { status: 400 });
    }
    rows.push({ field, look_for: lookFor, personalize, ...(personalize && instructions ? { instructions } : {}) });
  }

  const uniqueFields = new Set(rows.map(r => r.field));
  if (uniqueFields.size !== rows.length) {
    return NextResponse.json({ error: 'Each field can only be used once per rule.' }, { status: 400 });
  }
  if (!rows.some(r => r.personalize)) {
    return NextResponse.json({ error: 'Add at least one personalize row — a rule made only of filter rows never changes anything.' }, { status: 400 });
  }

  const { count } = await db
    .from('utm_auto_rules')
    .select('id', { count: 'exact', head: true })
    .eq('page_id', params.id);

  if ((count ?? 0) >= MAX_RULES_PER_PAGE) {
    return NextResponse.json({ error: `Maximum ${MAX_RULES_PER_PAGE} auto-personalization rules allowed per page.` }, { status: 400 });
  }

  const { data: inserted, error } = await db
    .from('utm_auto_rules')
    .insert({ page_id: params.id, rows })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rule: inserted });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;
  if (auth.wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const ruleId = req.nextUrl.searchParams.get('rule_id');
  if (!ruleId) return NextResponse.json({ error: 'rule_id is required' }, { status: 400 });

  const { error } = await db
    .from('utm_auto_rules')
    .delete()
    .eq('id', ruleId)
    .eq('page_id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
