import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

// UTM Personalization V2 (auto-detection) — insert-only rule creation.
// See docs/utm-personalization-v2-automation.md ("Known conflicts / gaps"):
// the manual /personalization-rules POST is full-replace (delete-all then
// insert), so it cannot be reused here without silently wiping every
// manually-authored rule on the page. This endpoint only ever inserts one
// new row and never touches existing ones.

const MAX_RULES = 20;
const MAX_CONDITIONS_PER_RULE = 5;

// Broader than the manual UI's 5-param list — auto-detection can key on
// anything tracker.js captures as a tracking param, excluding click IDs
// (unique per click, never useful as a match condition). Kept in sync by
// hand with tracker.js's CLICK_ID_PARAMS/EXTRA_ID_PARAMS; see that file for
// the authoritative list.
const LEGACY_UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const EXTRA_ID_PARAMS = ['h_ad_id', 'ad_id', 'adset_id', 'campaign_id', 'creative_id', 'placement_id'];

function isAllowedParam(name: string): boolean {
  if (LEGACY_UTM_PARAMS.includes(name)) return true;
  if (EXTRA_ID_PARAMS.includes(name)) return true;
  if (name.indexOf('hsa_') === 0) return true;
  return false;
}

interface Condition {
  match_param: string;
  match_value: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db.from('pages').select('workspace_id').eq('id', params.id).single();
  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const conditions = body.conditions as Condition[] | undefined;
  const overridesJson = (body.overrides_json ?? {}) as Record<string, string>;
  const isDraft = body.is_draft === true;
  const detectionId = typeof body.detection_id === 'string' ? body.detection_id : null;

  if (!Array.isArray(conditions) || conditions.length === 0) {
    return NextResponse.json({ error: 'At least one condition is required.' }, { status: 400 });
  }
  if (conditions.length > MAX_CONDITIONS_PER_RULE) {
    return NextResponse.json({ error: `Maximum ${MAX_CONDITIONS_PER_RULE} conditions allowed per rule.` }, { status: 400 });
  }

  const seenParams = new Set<string>();
  for (const cond of conditions) {
    if (!cond || typeof cond.match_param !== 'string' || !isAllowedParam(cond.match_param)) {
      return NextResponse.json({ error: `"${cond?.match_param}" is not a recognized tracking parameter.` }, { status: 400 });
    }
    if (typeof cond.match_value !== 'string' || !cond.match_value.trim()) {
      return NextResponse.json({ error: 'Every condition needs a value.' }, { status: 400 });
    }
    if (seenParams.has(cond.match_param)) {
      return NextResponse.json({ error: `"${cond.match_param}" is used more than once in this rule.` }, { status: 400 });
    }
    seenParams.add(cond.match_param);
  }

  // Drafts (rule shell created right after Accept, content not generated
  // yet) are allowed to have empty overrides — the existing manual-POST
  // "must change something" check only applies once a rule is meant to be
  // live/complete.
  if (!isDraft) {
    const hasFilledField = Object.values(overridesJson).some(v => typeof v === 'string' && v.trim());
    if (!hasFilledField) {
      return NextResponse.json({ error: 'This rule does not change anything on the page.' }, { status: 400 });
    }
    for (const [key, val] of Object.entries(overridesJson)) {
      if (typeof val === 'string' && val.startsWith('http') && !val.startsWith('https://')) {
        return NextResponse.json({ error: `"${key}" URL must start with https://` }, { status: 400 });
      }
    }
  }

  const { count: existingCount } = await db
    .from('personalization_rules')
    .select('id', { count: 'exact', head: true })
    .eq('page_id', params.id);

  if ((existingCount ?? 0) >= MAX_RULES) {
    return NextResponse.json({ error: `Maximum ${MAX_RULES} rules allowed per page.` }, { status: 400 });
  }

  const normalized = conditions.map(c => ({ match_param: c.match_param, match_value: c.match_value.trim() }));
  const signature = normalized
    .map(c => `${c.match_param}=${c.match_value.toLowerCase()}`)
    .sort()
    .join('&');

  const { data: existingRules } = await db
    .from('personalization_rules')
    .select('id, match_param, match_value, conditions_json, is_fallback')
    .eq('page_id', params.id)
    .eq('is_fallback', false);

  for (const rule of existingRules ?? []) {
    const existingConditions = (rule.conditions_json as Condition[] | null)
      ?? (rule.match_param && rule.match_value ? [{ match_param: rule.match_param, match_value: rule.match_value }] : []);
    const existingSignature = existingConditions
      .map(c => `${c.match_param}=${c.match_value.trim().toLowerCase()}`)
      .sort()
      .join('&');
    if (existingSignature === signature) {
      return NextResponse.json({ error: 'A rule with these exact conditions already exists.' }, { status: 400 });
    }
  }

  const firstCondition = normalized[0];
  const { data: inserted, error: insertError } = await db
    .from('personalization_rules')
    .insert({
      page_id: params.id,
      match_param: firstCondition.match_param,
      match_value: firstCondition.match_value,
      match_type: 'exact',
      conditions_json: normalized,
      overrides_json: overridesJson,
      priority: existingCount ?? 0,
      is_fallback: false,
      source: 'auto',
      is_draft: isDraft,
    })
    .select()
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  if (detectionId) {
    await db
      .from('utm_auto_detections')
      .update({ status: 'accepted', resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', detectionId)
      .eq('page_id', params.id);
  }

  return NextResponse.json({ rule: inserted });
}

// Complete a draft rule (Stage 2 — after AI content is generated and the
// user approves) by filling in overrides_json and flipping is_draft off.
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db.from('pages').select('workspace_id').eq('id', params.id).single();
  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json();
  const ruleId = body.rule_id as string | undefined;
  const overridesJson = (body.overrides_json ?? {}) as Record<string, string>;

  if (!ruleId) return NextResponse.json({ error: 'rule_id is required' }, { status: 400 });

  const hasFilledField = Object.values(overridesJson).some(v => typeof v === 'string' && v.trim());
  if (!hasFilledField) {
    return NextResponse.json({ error: 'This rule does not change anything on the page.' }, { status: 400 });
  }
  for (const [key, val] of Object.entries(overridesJson)) {
    if (typeof val === 'string' && val.startsWith('http') && !val.startsWith('https://')) {
      return NextResponse.json({ error: `"${key}" URL must start with https://` }, { status: 400 });
    }
  }

  const { data: updated, error } = await db
    .from('personalization_rules')
    .update({ overrides_json: overridesJson, is_draft: false })
    .eq('id', ruleId)
    .eq('page_id', params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rule: updated });
}
