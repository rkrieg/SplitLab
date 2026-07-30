import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

// UTM Personalization V2 pivot (2026-07-30). See docs/utm-personalization-v2-automation.md,
// "PIVOT" section. User-defined rule templates: which UTM field(s) to watch
// (AND'd together) plus an optional loose hint. No exact values are set here —
// the background cron judges incoming values against the hint via AI.

const MAX_RULES_PER_PAGE = 200;
const MAX_FIELDS_PER_RULE = 5;

const LEGACY_UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const EXTRA_ID_PARAMS = ['h_ad_id', 'ad_id', 'adset_id', 'campaign_id', 'creative_id', 'placement_id'];

function isAllowedField(name: string): boolean {
  if (LEGACY_UTM_PARAMS.includes(name)) return true;
  if (EXTRA_ID_PARAMS.includes(name)) return true;
  if (name.indexOf('hsa_') === 0) return true;
  return false;
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
  const fields = body.fields as string[] | undefined;
  const hint = typeof body.hint === 'string' ? body.hint.trim().slice(0, 500) : '';

  if (!Array.isArray(fields) || fields.length === 0) {
    return NextResponse.json({ error: 'Select at least one UTM field.' }, { status: 400 });
  }
  if (hint.length < 3) {
    return NextResponse.json({ error: 'Describe what to look for (at least a few words) — this guides the AI judgment.' }, { status: 400 });
  }
  if (fields.length > MAX_FIELDS_PER_RULE) {
    return NextResponse.json({ error: `Maximum ${MAX_FIELDS_PER_RULE} fields per rule.` }, { status: 400 });
  }
  for (const f of fields) {
    if (typeof f !== 'string' || !isAllowedField(f)) {
      return NextResponse.json({ error: `"${f}" is not a recognized tracking parameter.` }, { status: 400 });
    }
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
    .insert({ page_id: params.id, fields, hint })
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
