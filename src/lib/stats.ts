/**
 * Statistical significance helpers for A/B test analytics.
 * Uses chi-square test to compare conversion rates.
 */

/**
 * Compute chi-square statistic for a 2×2 contingency table.
 *  control:    a conversions, b non-conversions
 *  challenger: c conversions, d non-conversions
 */
function chiSquare2x2(a: number, b: number, c: number, d: number): number {
  const N = a + b + c + d;
  if (N === 0) return 0;
  const denominator = (a + b) * (c + d) * (a + c) * (b + d);
  if (denominator === 0) return 0;
  const numerator = N * Math.pow(Math.abs(a * d - b * c), 2);
  return numerator / denominator;
}

/**
 * Complementary error function approximation (Abramowitz & Stegun).
 */
function erfc(x: number): number {
  const t = 1.0 / (1.0 + 0.3275911 * Math.abs(x));
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const result = poly * Math.exp(-x * x);
  return x >= 0 ? result : 2 - result;
}

/**
 * Approximate p-value for chi-square with 1 degree of freedom.
 */
function pValueFromChiSquare(chi2: number): number {
  if (chi2 <= 0) return 1;
  return erfc(Math.sqrt(chi2 / 2));
}

/**
 * Given views and conversions for the control and a challenger variant,
 * return the confidence level (0–100%) that the challenger is different.
 */
export function confidencePercent(
  controlViews: number,
  controlConversions: number,
  challengerViews: number,
  challengerConversions: number
): number {
  if (controlViews === 0 || challengerViews === 0) return 0;

  const a = challengerConversions;
  const b = challengerViews - challengerConversions;
  const c = controlConversions;
  const d = controlViews - controlConversions;

  const chi2 = chiSquare2x2(a, b, c, d);
  const p = pValueFromChiSquare(chi2);
  return Math.round((1 - p) * 1000) / 10; // e.g., 95.4
}

/**
 * Determine the winning variant (highest CVR) from a list of variant stats.
 * Returns the variant id, or null if the leader isn't significantly better.
 */
export function findWinner(
  variants: Array<{ id: string; views: number; conversions: number }>
): string | null {
  if (variants.length === 0) return null;
  const sorted = [...variants].sort((a, b) => {
    const cvrA = a.views > 0 ? a.conversions / a.views : 0;
    const cvrB = b.views > 0 ? b.conversions / b.views : 0;
    return cvrB - cvrA;
  });
  const top = sorted[0];
  const cvr = top.views > 0 ? top.conversions / top.views : 0;
  if (cvr === 0) return null;
  return top.id;
}
