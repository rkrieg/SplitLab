import Stripe from 'stripe';

/**
 * Returns a fresh Stripe client on every call (no module-level singleton).
 * This is intentional — Stripe recommends not caching the client instance
 * across requests in serverless environments.
 *
 * Requires STRIPE_SECRET_KEY in env (test key for dev, live key for prod).
 */
export function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add it to your environment variables.'
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Stripe(key, { apiVersion: '2025-05-28.basil' as any });
}

export async function getStripePublishableKey(): Promise<string> {
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
  return key;
}
