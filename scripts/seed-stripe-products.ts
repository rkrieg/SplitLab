import { getUncachableStripeClient } from '../src/lib/stripeClient';

const PLANS = [
  {
    key: 'pro',
    name: 'Pro',
    description: 'For marketers running real tests',
    amount: 4900,
    metadata: {
      plan: 'pro',
      active_tests: '5',
      visitors_per_month: '25000',
    },
  },
  {
    key: 'agency',
    name: 'Agency',
    description: 'For agencies managing multiple clients',
    amount: 14900,
    metadata: {
      plan: 'agency',
      active_tests: 'unlimited',
      visitors_per_month: '100000',
      featured: 'true',
    },
  },
  {
    key: 'scale',
    name: 'Scale',
    description: 'For high-volume teams and networks',
    amount: 34900,
    metadata: {
      plan: 'scale',
      active_tests: 'unlimited',
      visitors_per_month: '500000',
    },
  },
];

async function main() {
  const stripe = await getUncachableStripeClient();

  for (const plan of PLANS) {
    const existing = await stripe.products.search({ query: `metadata['plan']:'${plan.key}'` });

    if (existing.data.length > 0) {
      console.log(`✓ ${plan.name} already exists (${existing.data[0].id})`);
      const prices = await stripe.prices.list({ product: existing.data[0].id, active: true });
      console.log(`  Price: ${prices.data[0]?.id} — $${(prices.data[0]?.unit_amount || 0) / 100}/mo`);
      continue;
    }

    const product = await stripe.products.create({
      name: `SplitLab ${plan.name}`,
      description: plan.description,
      metadata: plan.metadata,
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.amount,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { plan: plan.key },
    });

    console.log(`✓ Created ${plan.name}: product=${product.id}  price=${price.id}  $${plan.amount / 100}/mo`);
  }

  console.log('\nDone. Copy the price IDs above into your checkout route if needed.');
}

main().catch(console.error);
