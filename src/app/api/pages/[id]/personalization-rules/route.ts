import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

const VALID_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
const MAX_RULES = 20;
const MAX_CONDITIONS_PER_RULE = 5;

interface Condition {
  match_param: string;
  match_value: string;
}

/** A rule's conditions come from `conditions` (new multi-condition shape) or fall
 *  back to the legacy single match_param/match_value pair (old rules / old clients). */
function getConditions(rule: Record<string, unknown>): Condition[] {
  const conditions = rule.conditions;
  if (Array.isArray(conditions) && conditions.length > 0) {
    return conditions as Condition[];
  }
  if (typeof rule.match_param === 'string' && typeof rule.match_value === 'string' && rule.match_value.trim()) {
    return [{ match_param: rule.match_param, match_value: rule.match_value }];
  }
  return [];
}

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
  // Order-insensitive normalized condition signatures, to reject duplicate rules —
  // two rules with identical conditions can never both fire at runtime.
  const seenSignatures = new Map<string, number>();
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as Record<string, unknown>;

    const isFallback = rule.is_fallback === true;
    if (isFallback) { fallbackCount++; continue; }

    const conditions = getConditions(rule);

    if (conditions.length === 0) {
      return NextResponse.json({ error: `Rule ${i + 1}: at least one condition is required.` }, { status: 400 });
    }
    if (conditions.length > MAX_CONDITIONS_PER_RULE) {
      return NextResponse.json({ error: `Rule ${i + 1}: maximum ${MAX_CONDITIONS_PER_RULE} conditions allowed per rule.` }, { status: 400 });
    }

    const seenParams = new Set<string>();
    for (const cond of conditions) {
      if (!VALID_PARAMS.includes(cond.match_param as typeof VALID_PARAMS[number])) {
        return NextResponse.json(
          { error: `Rule ${i + 1}: match_param must be one of ${VALID_PARAMS.join(', ')}` },
          { status: 400 }
        );
      }
      if (!cond.match_value || typeof cond.match_value !== 'string' || !cond.match_value.trim()) {
        return NextResponse.json({ error: `Rule ${i + 1}: every condition needs a value.` }, { status: 400 });
      }
      if (seenParams.has(cond.match_param)) {
        return NextResponse.json({ error: `Rule ${i + 1}: "${cond.match_param}" is used more than once in the same rule.` }, { status: 400 });
      }
      seenParams.add(cond.match_param);
    }

    const signature = conditions
      .map(c => `${c.match_param}=${c.match_value.trim().toLowerCase()}`)
      .sort()
      .join('&');
    const dupeOf = seenSignatures.get(signature);
    if (dupeOf !== undefined) {
      return NextResponse.json(
        { error: `Rule ${i + 1} has the same conditions as Rule ${dupeOf + 1}. Change a value or delete one of them.` },
        { status: 400 }
      );
    }
    seenSignatures.set(signature, i);

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
    const isFallback = r.is_fallback === true;
    const conditions = isFallback ? [] : getConditions(r).map(c => ({ match_param: c.match_param, match_value: c.match_value.trim() }));
    // Dual-write the first condition into the legacy columns so old readers
    // (and the DB's "non-fallback rows need a match_value" constraint) still work.
    const firstCondition = conditions[0];
    return {
      page_id: params.id,
      match_param: isFallback ? 'utm_source' : (firstCondition?.match_param as string),
      match_value: isFallback ? null : (firstCondition?.match_value as string),
      match_type: 'exact',
      conditions_json: isFallback ? null : conditions,
      overrides_json: r.overrides_json ?? {},
      priority: typeof r.priority === 'number' ? r.priority : i,
      is_fallback: isFallback,
    };
  });

  const { data: inserted, error: insertError } = await db
    .from('personalization_rules')
    .insert(rows)
    .select();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  return NextResponse.json({ rules: inserted });
}
