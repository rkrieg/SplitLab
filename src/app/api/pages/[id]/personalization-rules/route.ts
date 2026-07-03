import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

const VALID_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
const MAX_RULES = 20;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, schema_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data: rules, error } = await db
    .from('personalization_rules')
    .select('*')
    .eq('page_id', params.id)
    .order('is_fallback', { ascending: true })
    .order('priority', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rules: rules ?? [] });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, schema_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let rules: unknown[];
  try {
    const body = await request.json();
    rules = body.rules;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!Array.isArray(rules)) {
    return NextResponse.json({ error: 'rules must be an array' }, { status: 400 });
  }

  // Allow empty array — means "delete all rules"
  if (rules.length > MAX_RULES) {
    return NextResponse.json({ error: `Maximum ${MAX_RULES} rules allowed per page.` }, { status: 400 });
  }

  // Validate each rule
  let fallbackCount = 0;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as Record<string, unknown>;

    const isFallback = rule.is_fallback === true;
    if (isFallback) { fallbackCount++; continue; }

    if (!VALID_PARAMS.includes(rule.match_param as typeof VALID_PARAMS[number])) {
      return NextResponse.json(
        { error: `Rule ${i + 1}: match_param must be one of ${VALID_PARAMS.join(', ')}` },
        { status: 400 }
      );
    }

    if (!rule.match_value || typeof rule.match_value !== 'string' || !rule.match_value.trim()) {
      return NextResponse.json({ error: `Rule ${i + 1}: match_value is required.` }, { status: 400 });
    }

    // XSS: any URL value must start with https://
    const overrides = rule.overrides_json as Record<string, string> | undefined;
    if (overrides) {
      for (const [key, val] of Object.entries(overrides)) {
        if (typeof val === 'string' && val.startsWith('http') && !val.startsWith('https://')) {
          return NextResponse.json({ error: `Rule ${i + 1}: "${key}" URL must start with https://` }, { status: 400 });
        }
      }
    }
  }

  if (fallbackCount > 1) {
    return NextResponse.json({ error: 'Only one fallback rule is allowed per page.' }, { status: 400 });
  }

  // Full replace in a transaction: delete all existing, insert new
  const { error: deleteError } = await db
    .from('personalization_rules')
    .delete()
    .eq('page_id', params.id);

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  if (rules.length === 0) {
    return NextResponse.json({ rules: [] });
  }

  const rows = rules.map((rule, i) => {
    const r = rule as Record<string, unknown>;
    return {
      page_id: params.id,
      match_param: r.is_fallback ? 'utm_source' : (r.match_param as string),
      match_value: r.is_fallback ? null : (r.match_value as string).trim(),
      match_type: 'exact',
      overrides_json: r.overrides_json ?? {},
      priority: typeof r.priority === 'number' ? r.priority : i,
      is_fallback: r.is_fallback === true,
    };
  });

  const { data: inserted, error: insertError } = await db
    .from('personalization_rules')
    .insert(rows)
    .select();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  return NextResponse.json({ rules: inserted });
}
