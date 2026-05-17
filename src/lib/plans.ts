export type PlanId = 'starter' | 'pro' | 'agency' | 'scale';

export interface PlanLimits {
  name: string;
  maxActiveTests: number;
  maxClients: number;
  monthlyVisitors: number;
  maxTeamSeats: number;
  maxDomains: number;
  allowAiGeneration: boolean;
  priceId?: string;
  monthlyPrice?: number;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  starter: {
    name: 'Free',
    maxActiveTests: 1,
    maxClients: 1,
    monthlyVisitors: 1_000,
    maxTeamSeats: 1,
    maxDomains: 0,
    allowAiGeneration: false,
  },
  pro: {
    name: 'Pro',
    maxActiveTests: 10,
    maxClients: 1,
    monthlyVisitors: 25_000,
    maxTeamSeats: 3,
    maxDomains: 1,

    allowAiGeneration: true,
    monthlyPrice: 49,
  },
  agency: {
    name: 'Agency',
    maxActiveTests: 50,
    maxClients: 10,
    monthlyVisitors: 100_000,
    maxTeamSeats: 10,
    maxDomains: 10,
    allowAiGeneration: true,
    monthlyPrice: 149,
  },
  scale: {
    name: 'Scale',
    maxActiveTests: Infinity,
    maxClients: Infinity,
    monthlyVisitors: Infinity,
    maxTeamSeats: Infinity,
    maxDomains: Infinity,
    allowAiGeneration: true,
    monthlyPrice: 349,
  },
};

export function getPlan(planId: string): PlanLimits {
  return PLANS[(planId as PlanId) ?? 'starter'] ?? PLANS.starter;
}

export function formatLimit(value: number): string {
  if (value === Infinity) return 'Unlimited';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}
