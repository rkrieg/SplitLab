/**
 * Traffic-split arithmetic for a test's variants.
 *
 * The bug this exists to kill: every weight-changing operation used to rewrite
 * the split to an EQUAL share across whatever variants were left. A test
 * running one page at 100% with six old pages parked at 0% — a shape the
 * product deliberately supports, see the 0%-weight inserts in
 * services/pages.ts — would silently become 14/14/14/14/14/14/14 the moment
 * anyone archived, deleted or added a variant. On a page taking real ad spend
 * that sends ~86% of paid traffic to dead pages, with no warning and no
 * confirmation step.
 *
 * The rule here instead: a weight change only ever redistributes the share
 * that actually moved, in proportion to what everyone else already holds.
 * Because that is multiplication, two properties come for free and are the
 * whole point:
 *
 *   - a variant parked at 0% stays at 0%, always (0 x anything = 0);
 *   - the ratios between every other variant are untouched.
 *
 * When proportions genuinely cannot be preserved — the variant losing traffic
 * is the only one that has any — there is no correct answer, so these
 * functions refuse instead of guessing. Guessing is what caused the incident.
 *
 * Adding a variant is stricter still: it moves no traffic at all. A new
 * variant joins at 0% and sits there until someone sets its weight on
 * purpose, so the only way live traffic ever changes is a deliberate edit to
 * a specific variant, with the resulting split shown before it is applied.
 *
 * Everything here is pure integer arithmetic over active variants only.
 * Archived variants are never passed in and can never hold weight.
 */

export interface WeightedVariant {
  id: string;
  traffic_weight: number;
}

export interface Weight {
  id: string;
  traffic_weight: number;
}

export type RebalanceResult =
  | { ok: true; weights: Weight[] }
  | { ok: false; reason: string };

/** Active weights must always sum to this. */
export const TOTAL_WEIGHT = 100;

/**
 * Scales `variants` so their weights sum to `total`, keeping every ratio
 * between them intact.
 *
 * Returns null when that is impossible: the group holds no traffic at all
 * (every weight is 0) but is being asked to absorb some. There is no
 * proportion to scale by, and spreading it evenly is exactly the behaviour
 * that broke production, so the caller has to refuse with its own message.
 *
 * Rounding uses largest-remainder, so the result sums to `total` exactly.
 * A zero-weight variant can never win a remainder point — its remainder is
 * always 0, and the number of points to hand out is always strictly less than
 * the number of variants with a non-zero remainder.
 */
export function scaleToTotal(variants: WeightedVariant[], total: number): Weight[] | null {
  if (variants.length === 0) return [];
  if (total === 0) return variants.map((v) => ({ id: v.id, traffic_weight: 0 }));

  const current = variants.reduce((sum, v) => sum + v.traffic_weight, 0);
  if (current <= 0) return null;

  const scaled = variants.map((v, index) => {
    const exact = (v.traffic_weight * total) / current;
    const floor = Math.floor(exact);
    return { id: v.id, traffic_weight: floor, remainder: exact - floor, index };
  });

  let leftover = total - scaled.reduce((sum, v) => sum + v.traffic_weight, 0);

  // Largest remainder first; ties broken by original order so the same input
  // always produces the same split.
  const byRemainder = [...scaled].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (const v of byRemainder) {
    if (leftover <= 0) break;
    v.traffic_weight += 1;
    leftover -= 1;
  }

  return scaled.map((v) => ({ id: v.id, traffic_weight: v.traffic_weight }));
}

/**
 * New split after a variant leaves the live rotation (archive or delete).
 *
 * Its share is absorbed by the others in proportion to what they already
 * hold. Archiving a variant that was already at 0% therefore changes nothing
 * at all, which is the single most common case and the one that caused the
 * incident.
 */
export function weightsAfterRemoval(
  active: WeightedVariant[],
  removedId: string,
): RebalanceResult {
  const removed = active.find((v) => v.id === removedId);
  if (!removed) return { ok: false, reason: 'Variant not found in the active split.' };

  const others = active.filter((v) => v.id !== removedId);
  if (others.length === 0) {
    return { ok: false, reason: 'A test must always keep at least one active variant.' };
  }

  const scaled = scaleToTotal(others, TOTAL_WEIGHT);
  if (!scaled) {
    return {
      ok: false,
      reason:
        'This is the only variant receiving traffic, so there is nowhere for its share to go. Give another variant traffic above 0% first, then remove this one.',
    };
  }

  return { ok: true, weights: [...scaled, { id: removedId, traffic_weight: 0 }] };
}

/**
 * New split after one existing variant is set to an explicit weight.
 *
 * The other variants shrink or grow proportionally to fill whatever is left,
 * so a variant parked at 0% stays parked rather than being handed live
 * traffic by a weight edit somewhere else on the test.
 */
export function weightsAfterSet(
  active: WeightedVariant[],
  variantId: string,
  weight: number,
): RebalanceResult {
  if (!active.some((v) => v.id === variantId)) {
    return { ok: false, reason: 'Variant not found in the active split.' };
  }
  if (!Number.isInteger(weight) || weight < 0 || weight > TOTAL_WEIGHT) {
    return { ok: false, reason: 'Traffic weight must be a whole number between 0 and 100.' };
  }

  const others = active.filter((v) => v.id !== variantId);
  if (others.length === 0) {
    if (weight !== TOTAL_WEIGHT) {
      return { ok: false, reason: 'The only active variant on a test must be at 100%.' };
    }
    return { ok: true, weights: [{ id: variantId, traffic_weight: TOTAL_WEIGHT }] };
  }

  const scaled = scaleToTotal(others, TOTAL_WEIGHT - weight);
  if (!scaled) {
    return {
      ok: false,
      reason:
        'Every other variant is at 0%, so there is nowhere for the freed traffic to go. Set the traffic on the variant you want to send it to instead.',
    };
  }

  return { ok: true, weights: [...scaled, { id: variantId, traffic_weight: weight }] };
}

/**
 * The weight a brand-new variant joins an existing test at: always 0%.
 *
 * Adding a variant never takes traffic away from a page that is already
 * running. That was the second half of the incident report — "even if you add
 * a variant, it essentially adds it on there as well" — and it is how
 * Unbounce behaves: the variant appears in the table at 0%, and the split
 * only moves when someone deliberately sets a weight afterwards, on the
 * variant they have decided should give the traffic up. No add can ever
 * surprise a live page.
 *
 * The one exception is a test with no active variants at all: something has
 * to carry the traffic or there is no split to serve, so the first variant
 * joins at 100%.
 */
export function weightForNewVariant(active: WeightedVariant[]): number {
  return active.length === 0 ? TOTAL_WEIGHT : 0;
}

/**
 * Does this set of weights form a valid live split?
 *
 * Used to reject partial or archived-variant weight writes before they reach
 * the database, so the "active variants always sum to 100" invariant holds no
 * matter which caller (dashboard, HTTP, MCP) is writing.
 */
export function validateFullSplit(
  weights: Weight[],
  activeIds: string[],
): { ok: true } | { ok: false; reason: string } {
  const given = new Set(weights.map((w) => w.id));
  if (given.size !== weights.length) {
    return { ok: false, reason: 'The same variant appears twice in the weights.' };
  }

  const activeSet = new Set(activeIds);
  const foreign = weights.filter((w) => !activeSet.has(w.id));
  if (foreign.length > 0) {
    return {
      ok: false,
      reason:
        'Weights can only be set on active variants — archived variants always sit at 0%. Unarchive it first if it should receive traffic.',
    };
  }

  const missing = activeIds.filter((id) => !given.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Weights must cover every active variant (${missing.length} missing). A partial update would leave the split not summing to 100.`,
    };
  }

  const total = weights.reduce((sum, w) => sum + w.traffic_weight, 0);
  if (total !== TOTAL_WEIGHT) {
    return { ok: false, reason: `Weights must sum to 100 (got ${total}).` };
  }

  return { ok: true };
}
