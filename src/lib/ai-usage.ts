import { db } from '@/lib/supabase-server';
import { aiCreditsForPlan, TOKENS_PER_CREDIT } from '@/lib/plans';

// Provider cost in MICRO-dollars per token, by model. $X per 1M tokens = X
// micro$/token, so these are just the per-million dollar rates as integers.
const MODEL_COST_MICROS: Record<string, { in: number; out: number }> = {
  'claude-opus-5':              { in: 5,  out: 25 },
  'claude-sonnet-5':            { in: 2,  out: 10 },
  'claude-sonnet-4-6':          { in: 3,  out: 15 },
  'claude-haiku-4-5':           { in: 1,  out: 5 },
  'claude-haiku-4-5-20251001':  { in: 1,  out: 5 },
};

/** Actual provider cost of a call, in micro-dollars (integer). */
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  // Unknown models fall back to Opus rates — the most expensive model we run.
  // Guessing low here silently undercharges overage; guessing high never does.
  const p = MODEL_COST_MICROS[model] ?? { in: 5, out: 25 };
  return inputTokens * p.in + outputTokens * p.out;
}

/** Markup applied to overage: we pass provider cost through at cost + 10%. */
export const OVERAGE_MARKUP = 1.1;

// ── Prepaid credit top-ups ──────────────────────────────────────────────────
// Retail price of a prepaid credit, in cents. $0.05/credit → $50 buys 1,000
// credits. Change this one number to reprice top-ups.
export const TOPUP_CENTS_PER_CREDIT = 5;
/** Purchasable top-up amounts, in cents ($50 / $100 / $200 / $500). */
export const TOPUP_AMOUNTS_CENTS = [5000, 10000, 20000, 50000];
/** Credits granted for a given dollar amount (in cents). */
export function creditsForCents(cents: number): number {
  return Math.floor(cents / TOPUP_CENTS_PER_CREDIT);
}

// ── Generated images ────────────────────────────────────────────────────────
// Images are priced per image, not per token, so they can't go through
// costMicros(). These are gpt-image-1's list prices for a 1024x1024 at each
// quality, in micro-dollars.
export const IMAGE_COST_MICROS: Record<string, number> = {
  low:     11_000,   // ~$0.011
  medium:  42_000,   // ~$0.042
  high:   167_000,   // ~$0.167
};

// What an image costs the user, in credits. Set at OUR cost, on the same basis
// the plan allowances were sized on (~$13 per 1,000 credits), so an image and a
// thousand tokens of text cost us roughly the same per credit charged. Charging
// at the top-up retail rate instead would undercharge images by ~4x.
export const IMAGE_CREDITS: Record<string, number> = {
  low:     1,
  medium:  4,
  high:   13,
};

/** Provider cost of one generated image, in micro-dollars. */
export function imageCostMicros(quality: string): number {
  return IMAGE_COST_MICROS[quality] ?? IMAGE_COST_MICROS.high;
}

/**
 * Tokens to charge for one generated image. The metering engine is token-based
 * end to end (the credit meter, the allowance gate, the overage split all work
 * in tokens), so an image is recorded as its credit price expressed in tokens
 * rather than adding a parallel per-image accounting path. The real dollar cost
 * still goes to ai_usage.cost_micros untouched, so reporting stays accurate.
 */
export function imageTokenEquivalent(quality: string): number {
  return (IMAGE_CREDITS[quality] ?? IMAGE_CREDITS.high) * TOKENS_PER_CREDIT;
}

export interface UsageContext {
  ownerId: string | null;
  workspaceId?: string | null;
  pageId?: string | null;
  operation: string; // prepare | edit | build | image | route
  /**
   * Account owner's plan. Optional: supplied by callers that already resolved
   * it (most do, via resolveWorkspaceOwner) to save a lookup per model call.
   * Falls back to a read on users.plan when absent.
   */
  plan?: string | null;
}

/**
 * Record one AI model call against the account owner. Best-effort — metering
 * must never break an AI request, so failures are logged and swallowed.
 * No-ops when ownerId is missing (usage we can't attribute isn't billed).
 */
export async function recordAiUsage(
  ctx: UsageContext,
  model: string,
  inputTokens: number,
  outputTokens: number,
  costMicrosOverride?: number,
): Promise<void> {
  if (!ctx.ownerId) return;
  const tokens = inputTokens + outputTokens;
  // Images are priced per image, so the caller passes the real cost; token
  // calls derive it from the model's rate card.
  const cost = costMicrosOverride ?? costMicros(model, inputTokens, outputTokens);
  try {
    await db.from('ai_usage').insert({
      owner_id:      ctx.ownerId,
      workspace_id:  ctx.workspaceId ?? null,
      page_id:       ctx.pageId ?? null,
      operation:     ctx.operation,
      model,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cost_micros:   cost,
    } as never);
  } catch (err) {
    console.error('[ai-usage] failed to record usage', err);
  }

  // Roll the call into the month and draw any portion past the plan allowance
  // from the owner's prepaid balance. Separate try/catch from the ledger insert
  // above: if the rollup fails we still want the raw usage row, which is what
  // the rollup can be rebuilt from.
  if (tokens <= 0) return;
  try {
    const plan = ctx.plan ?? (await lookupPlan(ctx.ownerId));
    await db.rpc('record_ai_usage_rollup', {
      p_owner:       ctx.ownerId,
      p_period:      periodStartIso().slice(0, 10),
      p_tokens:      tokens,
      p_cost_micros: Math.round(cost),
      p_plan_tokens: aiCreditsForPlan(plan) * TOKENS_PER_CREDIT,
    });
  } catch (err) {
    console.error('[ai-usage] failed to roll up usage', err);
  }
}

/** Account owner's plan, for callers that didn't already resolve it. */
async function lookupPlan(ownerId: string): Promise<string> {
  try {
    const { data } = await db.from('users').select('plan').eq('id', ownerId).single();
    return data?.plan ?? 'free';
  } catch {
    return 'free';
  }
}

/** First day of the current calendar month, ISO — the metering period for v1. */
function periodStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface AiUsageSummary {
  plan: string;
  planCredits?: number;        // monthly allowance from the plan alone (resets)
  topupCredits?: number;       // prepaid credits still unspent (rolls over)
  topupCreditsDrawn?: number;  // prepaid credits consumed this period
  creditsIncluded: number;     // plan allowance + prepaid drawn + prepaid remaining
  tokensIncluded: number;      // the same figure, in tokens
  tokensUsed: number;          // total tokens this period
  creditsUsed: number;         // ceil(tokensUsed / TOKENS_PER_CREDIT)
  tokensRemaining: number;     // max(0, included - used)
  percentUsed: number;         // 0..100+ of the included allowance
  overageTokens: number;       // tokens beyond plan allowance + prepaid balance
  overageCostCents: number;    // billable overage so far, our cost + 10%, rounded up
  periodStart: string;
}

/**
 * Compute the owner's AI usage summary for the current period. `overageCostCents`
 * is derived from the actual provider cost of usage beyond the allowance, at
 * cost + 10% — the amount we'd bill (bounded elsewhere by the user's spend cap).
 */
export async function getAiUsageSummary(ownerId: string, plan: string): Promise<AiUsageSummary> {
  const periodStart = periodStartIso();
  const period = periodStart.slice(0, 10);
  const planCredits = aiCreditsForPlan(plan);
  const planTokens = planCredits * TOKENS_PER_CREDIT;

  // This month's totals come from the rollup, which record_ai_usage_rollup()
  // keeps current. Falls back to scanning ai_usage if migration 067 hasn't been
  // applied, so the meter degrades to the old behaviour rather than erroring.
  let tokensUsed = 0;
  let overageCostMicros = 0;
  let topupTokensDrawn = 0;
  let haveRollup = false;
  if (ownerId) {
    const { data, error } = await db
      .from('ai_usage_monthly')
      .select('tokens, overage_cost_micros, topup_tokens_drawn')
      .eq('owner_id', ownerId)
      .eq('period', period)
      .maybeSingle();
    if (!error) {
      haveRollup = true;
      tokensUsed        = Number(data?.tokens ?? 0);
      overageCostMicros = Number(data?.overage_cost_micros ?? 0);
      topupTokensDrawn  = Number(data?.topup_tokens_drawn ?? 0);
    }
  }

  // Prepaid balance. Rolls over: it is whatever is left of every top-up ever
  // bought, not just this month's.
  let topupTokensRemaining = 0;
  if (ownerId && haveRollup) {
    const { data } = await db.from('users').select('ai_topup_tokens').eq('id', ownerId).maybeSingle();
    topupTokensRemaining = Number(data?.ai_topup_tokens ?? 0);
  }

  if (!haveRollup) {
    ({ tokensUsed, overageCostMicros, topupTokensDrawn, topupTokensRemaining } =
      await legacySummary(ownerId, periodStart, planTokens));
  }

  // Everything the user may spend this month: the resetting plan allowance,
  // plus the prepaid credits already drawn, plus what is still in the balance.
  // Written this way so `creditsUsed >= creditsIncluded` still means exactly
  // "out of everything", which is what the billing UI keys off.
  const tokensIncluded = planTokens + topupTokensDrawn + topupTokensRemaining;

  return {
    plan,
    planCredits,
    topupCredits:      Math.floor(topupTokensRemaining / TOKENS_PER_CREDIT),
    topupCreditsDrawn: Math.floor(topupTokensDrawn / TOKENS_PER_CREDIT),
    creditsIncluded:   Math.floor(tokensIncluded / TOKENS_PER_CREDIT),
    tokensIncluded,
    tokensUsed,
    creditsUsed: Math.ceil(tokensUsed / TOKENS_PER_CREDIT),
    tokensRemaining: Math.max(0, tokensIncluded - tokensUsed),
    percentUsed: tokensIncluded > 0 ? (tokensUsed / tokensIncluded) * 100 : (tokensUsed > 0 ? 100 : 0),
    overageTokens: Math.max(0, tokensUsed - (planTokens + topupTokensDrawn)),
    overageCostCents: Math.ceil(overageCostMicros / 10_000), // micro-dollars → cents
    periodStart,
  };
}

/**
 * Pre-migration-067 fallback: derive the period's figures by scanning ai_usage
 * directly, treating top-ups bought this period as the balance. Only runs if
 * the rollup table is missing; delete once 067 is applied everywhere.
 */
async function legacySummary(ownerId: string, periodStart: string, planTokens: number) {
  let topupTokens = 0;
  if (ownerId) {
    const { data: topups, error } = await db
      .from('ai_credit_topups')
      .select('credits')
      .eq('owner_id', ownerId)
      .gte('created_at', periodStart);
    if (!error && topups) {
      topupTokens = topups.reduce((a, t) => a + (t.credits ?? 0), 0) * TOKENS_PER_CREDIT;
    }
  }

  const included = planTokens + topupTokens;
  const { data } = await db
    .from('ai_usage')
    .select('input_tokens, output_tokens, cost_micros, created_at')
    .eq('owner_id', ownerId)
    .gte('created_at', periodStart)
    .order('created_at', { ascending: true });

  let tokensUsed = 0;
  let overageCostMicros = 0;
  for (const r of data ?? []) {
    const rowTokens = (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
    const before = tokensUsed;
    tokensUsed += rowTokens;
    if (tokensUsed > included && rowTokens > 0) {
      const overTokens = tokensUsed - Math.max(before, included);
      overageCostMicros += (r.cost_micros ?? 0) * Math.min(1, overTokens / rowTokens) * OVERAGE_MARKUP;
    }
  }

  // Split the period's top-ups into spent/unspent so the caller's arithmetic
  // (included = plan + drawn + remaining) holds on this path too.
  const topupTokensDrawn = Math.min(Math.max(0, tokensUsed - planTokens), topupTokens);
  return {
    tokensUsed,
    overageCostMicros,
    topupTokensDrawn,
    topupTokensRemaining: topupTokens - topupTokensDrawn,
  };
}

export type AllowanceReason = 'ok' | 'no_ai' | 'over_allowance' | 'over_cap';

export interface AllowanceResult {
  allowed: boolean;
  reason: AllowanceReason;
  summary: AiUsageSummary;
  overage: { enabled: boolean; capCents: number };
}

/**
 * Gate an AI call for an account owner. "Allowance" here means the monthly plan
 * credits plus any prepaid balance still unspent — plan credits are drawn first,
 * then prepaid, then overage. Called before generating:
 *  - within the allowance                  → allowed
 *  - over allowance, overage OFF           → blocked (soft cap; user can enable overage)
 *  - over allowance, overage ON, under cap → allowed (billed as overage)
 *  - over allowance, overage ON, at cap    → blocked (raise the spend cap)
 *  - no plan credits and no prepaid balance → blocked
 *
 * Degrades safely: if the ai_usage table / overage columns don't exist yet
 * (migration 049 not applied), usage reads as zero and settings default, so
 * every call is "within allowance" rather than erroring.
 */
export async function checkAiAllowance(ownerId: string | null, plan: string): Promise<AllowanceResult> {
  const summary = await getAiUsageSummary(ownerId ?? '', plan);

  let enabled = false;
  let capCents = 5000;
  if (ownerId) {
    try {
      const { data } = await db
        .from('users')
        .select('ai_overage_enabled, ai_overage_cap_cents')
        .eq('id', ownerId)
        .single();
      enabled = data?.ai_overage_enabled ?? false;
      capCents = data?.ai_overage_cap_cents ?? 5000;
    } catch {
      /* columns not present yet — use defaults */
    }
  }
  const overage = { enabled, capCents };

  if (summary.creditsIncluded <= 0) {
    return { allowed: false, reason: 'no_ai', summary, overage };
  }
  if (summary.tokensUsed < summary.tokensIncluded) {
    return { allowed: true, reason: 'ok', summary, overage };
  }
  // Beyond the included allowance:
  if (!enabled) return { allowed: false, reason: 'over_allowance', summary, overage };
  if (summary.overageCostCents >= capCents) return { allowed: false, reason: 'over_cap', summary, overage };
  return { allowed: true, reason: 'ok', summary, overage };
}

/**
 * The JSON body a soft-capped route returns, so all three of them (follow-up,
 * rebuild-flow, schema-from-html) say the same thing.
 *
 * `owner` is the part the editor cannot work out on its own. The person hitting
 * the cap is often not the account being billed — an invited team member spends
 * the client owner's credits — and the upsell can only offer to buy credits or
 * turn on overage to someone allowed to spend on that account. Without this the
 * modal hands a team member two buttons that write to their own account while
 * the gate keeps reading the owner's, so they pay and stay blocked.
 */
export function softCapBody(
  gate: AllowanceResult,
  owner: { id: string | null; name: string | null },
  viewer: { id: string; role: string },
) {
  const isSelf = !!owner.id && owner.id === viewer.id;
  return {
    error: gate.reason === 'over_cap'
      ? 'You\'ve reached your AI overage spend cap. Raise it in Billing to continue.'
      : 'You\'ve used all your AI credits. Buy more (they never expire) or enable overage in Billing to continue.',
    softCap: true,
    reason: gate.reason,
    usage: gate.summary,
    overage: gate.overage,
    owner: {
      isSelf,
      name: owner.name,
      canManage: isSelf || viewer.role === 'admin',
    },
  };
}
