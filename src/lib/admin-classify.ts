// Classify an account so real customers are distinguishable from ones we set up
// in the backend (comped) and throwaway test accounts.

// Disposable / fake-identity email domains used for QA (yopmail + the
// fakenamegenerator.com family are the big ones in this DB).
const TEST_DOMAINS = new Set([
  'yopmail.com', 'mailinator.com', 'guerrillamail.com', 'dispostable.com', 'trashmail.com',
  'example.com', 'test.com',
  'jourrapide.com', 'armyspy.com', 'dayrep.com', 'einrot.com', 'cuvox.de', 'gustr.com',
  'teleworm.us', 'fleckens.hu', 'ifcoat.com', 'rhyta.com', 'superrito.com',
]);

export type AccountType = 'paying' | 'comped' | 'test' | 'free';

export function isTestEmail(email?: string | null): boolean {
  if (!email) return true;
  const [local, domain] = email.toLowerCase().split('@');
  if (!domain) return true;
  if (TEST_DOMAINS.has(domain)) return true;
  return /(^|[._+-])(test|demo|qa|dummy|fake|temp|sample)([._+-]|\d|$)/.test(local);
}

/**
 * - paying: has a real Stripe billing relationship (active sub) or has been charged.
 * - comped: on a paid plan but with NO real Stripe billing → set up in the backend by us.
 * - test:   throwaway/fake email address.
 * - free:   genuine free account.
 * Order matters: a charged account is "paying" even if its email looks test-y.
 */
export function classifyAccount(
  u: { email?: string | null; plan?: string | null; subscription_status?: string | null; stripe_subscription_id?: string | null },
  billedCents: number,
): AccountType {
  const hasRealBilling = (!!u.stripe_subscription_id && u.subscription_status === 'active') || billedCents > 0;
  if (hasRealBilling) return 'paying';
  if (isTestEmail(u.email)) return 'test';
  if ((u.plan ?? 'free') !== 'free') return 'comped';
  return 'free';
}

export const ACCOUNT_TYPE_META: Record<AccountType, { label: string; badge: string }> = {
  paying: { label: 'Paying', badge: 'bg-green-500/15 text-green-700 dark:text-green-400' },
  comped: { label: 'Comped', badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  test:   { label: 'Test',   badge: 'bg-slate-400/15 text-slate-500 dark:text-slate-400' },
  free:   { label: 'Free',   badge: 'bg-slate-400/10 text-slate-500 dark:text-slate-400' },
};
