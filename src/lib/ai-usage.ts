import { db } from '@/lib/supabase-server';
import { aiCreditsForPlan, TOKENS_PER_CREDIT } from '@/lib/plans';

// Provider cost in MICRO-dollars per token, by model. $X per 1M tokens = X
// micro$/token, so these are just the per-million dollar rates as integers.
const MODEL_COST_MICROS: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6':          { in: 3,  out: 15 },
  'claude-sonnet-5':            { in: 3,  out: 15 },
  'claude-haiku-4-5':           { in: 1,  out: 5 },
  'claude-haiku-4-5-20251001':  { in: 1,  out: 5 },
};

/** Actual provider cost of a call, in micro-dollars (integer). */
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_COST_MICROS[model] ?? { in: 3, out: 15 }; // default to Sonnet rates
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

export interface UsageContext {
  ownerId: string | null;
  workspaceId?: string | null;
  pageId?: string | null;
  operation: string; // prepare | edit | build | image | route
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
): Promise<void> {
  if (!ctx.ownerId) return;
  try {
    await db.from('ai_usage').insert({
      owner_id:      ctx.ownerId,
      workspace_id:  ctx.workspaceId ?? null,
      page_id:       ctx.pageId ?? null,
      operation:     ctx.operation,
      model,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cost_micros:   costMicros(model, inputTokens, outputTokens),
    } as never);
  } catch (err) {
    console.error('[ai-usage] failed to record usage', err);
  }
}

/** First day of the current calendar month, ISO — the metering period for v1. */
function periodStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface AiUsageSummary {
  plan: string;
  planCredits?: number;        // monthly allowance from the plan alone
  topupCredits?: number;       // prepaid credits added this period
  creditsIncluded: number;     // monthly allowance, in credits
  tokensIncluded: number;      // allowance in tokens
  tokensUsed: number;          // total tokens this period
  creditsUsed: number;         // ceil(tokensUsed / TOKENS_PER_CREDIT)
  tokensRemaining: number;     // max(0, included - used)
  percentUsed: number;         // 0..100+ of the included allowance
  overageTokens: number;       // tokens beyond the allowance
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

  // Prepaid top-ups bought this period add to the plan allowance so the meter
  // reflects purchased credits. Degrades to 0 if the table isn't present yet.
  let topupCredits = 0;
  if (ownerId) {
    const { data: topups, error } = await db
      .from('ai_credit_topups')
      .select('credits')
      .eq('owner_id', ownerId)
      .gte('created_at', periodStart);
    if (!error && topups) topupCredits = topups.reduce((a, t) => a + (t.credits ?? 0), 0);
  }

  const planCredits = aiCreditsForPlan(plan);
  const creditsIncluded = planCredits + topupCredits;
  const tokensIncluded = creditsIncluded * TOKENS_PER_CREDIT;

  const { data } = await db
    .from('ai_usage')
    .select('input_tokens, output_tokens, cost_micros, created_at')
    .eq('owner_id', ownerId)
    .gte('created_at', periodStart)
    .order('created_at', { ascending: true });

  const rows = data ?? [];
  let tokensUsed = 0;
  let overageCostMicros = 0;
  for (const r of rows) {
    const rowTokens = (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
    const before = tokensUsed;
    tokensUsed += rowTokens;
    // The portion of this row's tokens that fell beyond the allowance bills as
    // overage; charge that fraction of the row's actual cost, at cost + 10%.
    if (tokensUsed > tokensIncluded && rowTokens > 0) {
      const overTokens = tokensUsed - Math.max(before, tokensIncluded);
      const overFraction = Math.min(1, overTokens / rowTokens);
      overageCostMicros += (r.cost_micros ?? 0) * overFraction * OVERAGE_MARKUP;
    }
  }

  const overageTokens = Math.max(0, tokensUsed - tokensIncluded);
  return {
    plan,
    planCredits,
    topupCredits,
    creditsIncluded,
    tokensIncluded,
    tokensUsed,
    creditsUsed: Math.ceil(tokensUsed / TOKENS_PER_CREDIT),
    tokensRemaining: Math.max(0, tokensIncluded - tokensUsed),
    percentUsed: tokensIncluded > 0 ? (tokensUsed / tokensIncluded) * 100 : (tokensUsed > 0 ? 100 : 0),
    overageTokens,
    overageCostCents: Math.ceil(overageCostMicros / 10_000), // micro-dollars → cents
    periodStart,
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
 * Gate an AI call for an account owner. Called before generating:
 *  - within the monthly allowance         → allowed
 *  - over allowance, overage OFF          → blocked (soft cap; user can enable overage)
 *  - over allowance, overage ON, under cap → allowed (billed as overage)
 *  - over allowance, overage ON, at cap    → blocked (raise the spend cap)
 *  - plan has no AI credits                → blocked
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
