export type PlanId = 'starter' | 'pro' | 'agency' | 'scale';

export interface PlanLimits {
  name: string;
  maxActiveTests: number;
  maxClients: number;
  aiGeneration: boolean;
  monthlyVisitors: number;
  priceId?: string;
  monthlyPrice?: number;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  starter: {
    name: 'Free',
    maxActiveTests: 1,
    maxClients: 1,
    aiGeneration: false,
    monthlyVisitors: 5_000,
  },
  pro: {
    name: 'Pro',
    maxActiveTests: 10,
    maxClients: 5,
    aiGeneration: true,
    monthlyVisitors: 50_000,
    monthlyPrice: 49,
  },
  agency: {
    name: 'Agency',
    maxActiveTests: 50,
    maxClients: 20,
    aiGeneration: true,
    monthlyVisitors: 250_000,
    monthlyPrice: 149,
  },
  scale: {
    name: 'Scale',
    maxActiveTests: Infinity,
    maxClients: Infinity,
    aiGeneration: true,
    monthlyVisitors: Infinity,
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
