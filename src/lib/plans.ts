// TODO (post-trial): Move PLAN_LIMITS to a DB table (e.g. plan_configs) so limits
// can be changed without a code deployment. Currently safe because limit checks
// happen server-side — these values are never exposed to the client.

/**
 * Hard limits enforced by the backend per plan.
 * Use Infinity for "unlimited" — `count >= Infinity` is always false so no special
 * casing needed in enforcement logic.
 *
 * Free    → 0 domains, 1 test, 2 variants/test, 1 client
 * Pro     → 1 domain, 10 tests, unlimited variants, 1 client
 * Agency  → 10 domains, 50 tests, unlimited variants, 10 clients
 * Scale   → unlimited everything
 */
// Domain limit is 1 per client/workspace (confirmed by client).
// "Up to 10 custom domains" on Agency = 10 clients × 1 domain each, not 10 per workspace.
export const PLAN_LIMITS: Record<string, { domains: number; tests: number; variants: number; clients: number; teamSeats: number }> = {
  free:   { domains: 0,        tests: 1,        variants: 2,         clients: 1,         teamSeats: 0        },
  pro:    { domains: 1,        tests: 10,       variants: Infinity,  clients: 1,         teamSeats: 1        },
  agency: { domains: 1,        tests: 50,       variants: Infinity,  clients: 10,        teamSeats: 10       },
  scale:  { domains: Infinity, tests: Infinity, variants: Infinity,  clients: Infinity,  teamSeats: Infinity },
};

export interface Plan {
  id: 'free' | 'pro' | 'agency' | 'scale';
  label: string;
  price: string;
  sub: string;
  features: string[];
  cta: string;
  highlight: boolean;
  signupHref: string;
}

// ─── Billing UI helpers ──────────────────────────────────────────────────────

/** Canonical plan IDs used in the DB and Stripe metadata. */
export type PlanId = 'free' | 'pro' | 'agency' | 'scale';

/** Rich plan details used by the billing page. */
export interface PlanDetails {
  name: string;
  /** null = free forever */
  monthlyPrice: number | null;
  maxActiveTests: number;
  maxClients: number;
  /** monthly visitor cap — Infinity = unlimited */
  monthlyVisitors: number;
  maxDomains: number;
  maxTeamSeats: number;
  features: string[];
}

export const PLAN_DETAILS: Record<PlanId, PlanDetails> = {
  free: {
    name: 'Free',
    monthlyPrice: null,
    maxActiveTests: 1,
    maxClients: 1,
    monthlyVisitors: 5,
    maxDomains: 0,
    maxTeamSeats: 0,
    features: ['1 active test', '2 variants per test', '1,000 visitors/mo', 'Basic analytics'],
  },
  pro: {
    name: 'Pro',
    monthlyPrice: 49,
    maxActiveTests: 10,
    maxClients: 1,
    monthlyVisitors: 10,
    maxDomains: 1,
    maxTeamSeats: 1,
    features: ['10 active tests', 'Unlimited variants', '25,000 visitors/mo', '1 custom domain', 'CSV export', 'Priority email support'],
  },
  agency: {
    name: 'Agency',
    monthlyPrice: 149,
    maxActiveTests: 50,
    maxClients: 10,
    monthlyVisitors: 15,
    maxDomains: 10,
    maxTeamSeats: 10,
    features: ['50 active tests', 'Up to 10 clients', '100,000 visitors/mo', 'Up to 10 custom domains', 'Team seats'],
  },
  scale: {
    name: 'Scale',
    monthlyPrice: 349,
    maxActiveTests: Infinity,
    maxClients: Infinity,
    monthlyVisitors: Infinity,
    maxDomains: Infinity,
    maxTeamSeats: Infinity,
    features: ['Unlimited tests', 'Unlimited clients', 'Unlimited visitors/mo', 'Unlimited domains', 'Team seats', 'Priority support'],
  },
};

/** Safe lookup — falls back to 'free' for unknown plan strings. */
export function getPlanDetails(planId: string): PlanDetails {
  return PLAN_DETAILS[(planId as PlanId)] ?? PLAN_DETAILS.free;
}

/** Human-readable number for limit display (1000 → '1k', Infinity → 'Unlimited'). */
export function formatLimit(value: number): string {
  if (value === Infinity) return 'Unlimited';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}

// ─── Landing page plan cards ─────────────────────────────────────────────────

export const PLANS: Plan[] = [
  {
    id: 'free',
    label: 'Starter',
    price: 'Free',
    sub: 'Perfect for trying SplitLab out',
    features: ['1 active test', '2 variants per test', '1,000 visitors/mo', 'Basic analytics', 'Zero-config tracker.js'],
    cta: 'Get Started Free',
    highlight: false,
    signupHref: '/signup?plan=free',
  },
  {
    id: 'pro',
    label: 'Pro',
    price: '$49',
    sub: 'For marketers running real tests',
    features: ['10 active tests', 'Unlimited variants', '25,000 visitors/mo', '1 custom domain', 'CSV export', 'Conversion goals', 'Priority email support'],
    cta: 'Start Pro',
    highlight: false,
    signupHref: '/signup?plan=pro',
  },
  {
    id: 'agency',
    label: 'Agency',
    price: '$149',
    sub: 'For agencies managing multiple clients',
    features: ['50 active tests', 'Up to 10 clients', '100,000 visitors/mo', 'Up to 10 custom domains', 'Team seats', 'Custom scripts per variant', 'UTM personalization'],
    cta: 'Start Agency',
    highlight: true,
    signupHref: '/signup?plan=agency',
  },
  {
    id: 'scale',
    label: 'Scale',
    price: '$349',
    sub: 'For high-volume teams and networks',
    features: ['Unlimited tests', 'Unlimited clients', 'Unlimited visitors/mo', 'Unlimited custom domains', 'White-label branding', 'Webhook integrations', 'Priority support'],
    cta: 'Start Scale',
    highlight: false,
    signupHref: '/signup?plan=scale',
  },
];
