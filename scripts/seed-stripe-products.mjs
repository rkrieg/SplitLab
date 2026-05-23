/**
 * Run to create the 3 SplitLab subscription products in Stripe.
 * Idempotent — skips products that already exist (checked via metadata.plan).
 *
 * Usage (from project root):
 *   node scripts/seed-stripe-products.mjs
 *
 * Reads STRIPE_SECRET_KEY from .env.local automatically.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Load .env.local manually (no dotenv needed) ───────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath   = path.resolve(__dirname, '../.env.local');

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Plans to create ───────────────────────────────────────────────────────
const PLANS = [
  {
    key:         'pro',
    name:        'Pro',
    description: 'For marketers running real tests',
    amount:      4900,   // $49.00
    metadata:    { plan: 'pro', active_tests: '10', visitors_per_month: '25000' },
  },
  {
    key:         'agency',
    name:        'Agency',
    description: 'For agencies managing multiple clients',
    amount:      14900,  // $149.00
    metadata:    { plan: 'agency', active_tests: '50', visitors_per_month: '100000', featured: 'true' },
  },
  {
    key:         'scale',
    name:        'Scale',
    description: 'For high-volume teams and networks',
    amount:      34900,  // $349.00
    metadata:    { plan: 'scale', active_tests: 'unlimited', visitors_per_month: 'unlimited' },
  },
];

async function main() {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('❌  STRIPE_SECRET_KEY not found in .env.local');
    process.exit(1);
  }

  // Dynamic import of stripe (already installed)
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(stripeKey, { apiVersion: '2025-05-28.basil' });

  const mode = stripeKey.startsWith('sk_live') ? '🔴 LIVE' : '🟡 TEST';
  console.log(`\nStripe mode: ${mode}\n`);

  const priceIds = {};

  for (const plan of PLANS) {
    // Check if already exists
    const existing = await stripe.products.search({
      query: `metadata['plan']:'${plan.key}'`,
    });

    if (existing.data.length > 0) {
      const product = existing.data[0];
      const prices  = await stripe.prices.list({ product: product.id, active: true });
      const priceId = prices.data[0]?.id ?? '(no active price)';
      priceIds[plan.key] = priceId;
      console.log(`✓ ${plan.name} already exists`);
      console.log(`  Price ID: ${priceId}  ($${(prices.data[0]?.unit_amount ?? 0) / 100}/mo)\n`);
      continue;
    }

    // Create product + price
    const product = await stripe.products.create({
      name:        `SplitLab ${plan.name}`,
      description: plan.description,
      metadata:    plan.metadata,
    });

    const price = await stripe.prices.create({
      product:     product.id,
      unit_amount: plan.amount,
      currency:    'usd',
      recurring:   { interval: 'month' },
      metadata:    { plan: plan.key },
    });

    priceIds[plan.key] = price.id;
    console.log(`✓ Created ${plan.name}  ($${plan.amount / 100}/mo)`);
    console.log(`  Price ID: ${price.id}\n`);
  }

  console.log('─────────────────────────────────────────────────────────');
  console.log('Add these to your Vercel environment variables:\n');
  console.log(`STRIPE_PRICE_PRO=${priceIds['pro']    ?? ''}`);
  console.log(`STRIPE_PRICE_AGENCY=${priceIds['agency'] ?? ''}`);
  console.log(`STRIPE_PRICE_SCALE=${priceIds['scale']  ?? ''}`);
  console.log('─────────────────────────────────────────────────────────\n');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
