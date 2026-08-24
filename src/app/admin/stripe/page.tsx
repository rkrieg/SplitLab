import { requireAdmin } from '@/lib/admin-auth';
import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

export const dynamic = 'force-dynamic';

type Status = 'ok' | 'warn' | 'bad';

function Row({ status, label, detail }: { status: Status; label: string; detail?: string }) {
  const Icon = status === 'ok' ? CheckCircle2 : status === 'warn' ? AlertTriangle : XCircle;
  const color = status === 'ok' ? 'text-green-600 dark:text-green-400' : status === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  return (
    <div className="flex items-start gap-2.5 py-2 border-b border-slate-50 dark:border-slate-800/50 last:border-0">
      <Icon size={16} className={`${color} flex-shrink-0 mt-0.5`} />
      <div className="min-w-0">
        <p className="text-sm text-slate-800 dark:text-slate-200">{label}</p>
        {detail && <p className="text-xs text-slate-500 dark:text-slate-400 break-all">{detail}</p>}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      <div>{children}</div>
    </div>
  );
}

const PLAN_PRICE_ENV: Record<string, string | undefined> = {
  pro: process.env.STRIPE_PRICE_PRO,
  growth: process.env.STRIPE_PRICE_GROWTH,
  agency: process.env.STRIPE_PRICE_AGENCY,
  scale: process.env.STRIPE_PRICE_SCALE,
};

export default async function AdminStripeHealth() {
  await requireAdmin();

  const secret = process.env.STRIPE_SECRET_KEY || '';
  const mode = secret.startsWith('sk_live') ? 'live' : secret.startsWith('sk_test') ? 'test' : 'missing';
  const pub = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
  const pubMode = pub.startsWith('pk_live') ? 'live' : pub.startsWith('pk_test') ? 'test' : 'missing';
  const webhookSecretSet = !!process.env.STRIPE_WEBHOOK_SECRET;
  const overageMeter = process.env.STRIPE_AI_OVERAGE_METER_EVENT || '';
  const overagePrice = process.env.STRIPE_AI_OVERAGE_PRICE || '';

  // Resolve each configured plan price against Stripe.
  const priceRows: { plan: string; status: Status; detail: string }[] = [];
  const webhookRows: { status: Status; label: string; detail: string }[] = [];
  let overagePriceDetail = overagePrice ? 'checking…' : 'STRIPE_AI_OVERAGE_PRICE not set';

  if (mode !== 'missing') {
    const stripe = getStripeClient();
    for (const [plan, priceId] of Object.entries(PLAN_PRICE_ENV)) {
      if (!priceId) { priceRows.push({ plan, status: 'bad', detail: `STRIPE_PRICE_${plan.toUpperCase()} not set` }); continue; }
      try {
        const p = await stripe.prices.retrieve(priceId);
        const amount = p.unit_amount != null ? `$${(p.unit_amount / 100).toFixed(0)}/${p.recurring?.interval ?? 'once'}` : '—';
        const modeOk = p.livemode === (mode === 'live');
        priceRows.push({ plan, status: p.active && modeOk ? 'ok' : 'warn', detail: `${amount} · ${p.livemode ? 'live' : 'test'} · ${p.active ? 'active' : 'inactive'}${modeOk ? '' : ' · MODE MISMATCH'}` });
      } catch {
        priceRows.push({ plan, status: 'bad', detail: `price ${priceId} not found in this mode` });
      }
    }

    // Webhook endpoints
    try {
      const eps = await stripe.webhookEndpoints.list({ limit: 20 });
      const needed = ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_succeeded', 'invoice.payment_failed'];
      const matching = eps.data.filter((e) => e.url.includes('/api/stripe/webhook'));
      if (matching.length === 0) {
        webhookRows.push({ status: 'bad', label: 'No webhook endpoint points to /api/stripe/webhook', detail: `${eps.data.length} endpoint(s) found` });
      } else {
        for (const e of matching) {
          const evs = e.enabled_events.includes('*') ? needed : e.enabled_events;
          const missing = needed.filter((n) => !evs.includes(n));
          webhookRows.push({
            status: e.status === 'enabled' && missing.length === 0 ? 'ok' : 'warn',
            label: e.url,
            detail: `${e.status}${missing.length ? ` · missing events: ${missing.join(', ')}` : ' · all required events subscribed'}`,
          });
        }
      }
    } catch {
      webhookRows.push({ status: 'warn', label: 'Could not list webhook endpoints', detail: 'Stripe API error' });
    }

    // Overage metered price
    if (overagePrice) {
      try {
        const p = await stripe.prices.retrieve(overagePrice);
        overagePriceDetail = `${p.recurring?.usage_type === 'metered' ? 'metered' : 'NOT metered'} · unit ${p.unit_amount ?? '?'} · ${p.livemode ? 'live' : 'test'}`;
      } catch {
        overagePriceDetail = `price ${overagePrice} not found`;
      }
    }
  }

  // DB tables the billing features rely on
  const tableStatus = async (t: string): Promise<Status> => {
    const { error } = await db.from(t).select('*', { head: true, count: 'exact' });
    return error ? 'bad' : 'ok';
  };
  const [aiUsageOk, topupsOk] = await Promise.all([tableStatus('ai_usage'), tableStatus('ai_credit_topups')]);

  const overageConfigured = !!overageMeter && !!overagePrice;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold">Stripe health</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Verify this environment is wired for real payments.</p>
      </div>

      <Card title="Keys & mode">
        <Row status={mode === 'missing' ? 'bad' : mode === 'live' ? 'ok' : 'warn'} label={`Secret key: ${mode}`} detail={mode === 'test' ? 'Test mode — no real charges. Production needs sk_live_.' : mode === 'missing' ? 'STRIPE_SECRET_KEY not set here' : 'Live mode'} />
        <Row status={pubMode === 'missing' ? 'bad' : pubMode === mode ? 'ok' : 'warn'} label={`Publishable key: ${pubMode}`} detail={pubMode !== mode ? 'Should match the secret key mode' : undefined} />
        <Row status={webhookSecretSet ? 'ok' : 'bad'} label="Webhook signing secret" detail={webhookSecretSet ? 'STRIPE_WEBHOOK_SECRET set' : 'STRIPE_WEBHOOK_SECRET missing — webhooks will fail signature check'} />
      </Card>

      <Card title="Plan prices">
        {priceRows.length === 0 ? <p className="text-sm text-slate-400 py-2">Stripe not configured in this environment.</p>
          : priceRows.map((r) => <Row key={r.plan} status={r.status} label={r.plan[0].toUpperCase() + r.plan.slice(1)} detail={r.detail} />)}
      </Card>

      <Card title="Webhook endpoints">
        {webhookRows.length === 0 ? <p className="text-sm text-slate-400 py-2">Stripe not configured in this environment.</p>
          : webhookRows.map((r, i) => <Row key={i} status={r.status} label={r.label} detail={r.detail} />)}
      </Card>

      <Card title="AI billing (top-ups & overage)">
        <Row status={topupsOk === 'ok' ? 'ok' : 'bad'} label="ai_credit_topups table" detail={topupsOk === 'ok' ? 'present — top-ups can grant credits' : 'missing — run migration 057; top-ups would charge but not grant'} />
        <Row status={aiUsageOk === 'ok' ? 'ok' : 'bad'} label="ai_usage table" detail={aiUsageOk === 'ok' ? 'present — usage metering records' : 'missing — run migration 055'} />
        <Row status={overageConfigured ? 'ok' : 'warn'} label="Metered overage billing" detail={overageConfigured ? `meter "${overageMeter}" + price configured` : 'Not configured — auto-bill overage will not charge until STRIPE_AI_OVERAGE_METER_EVENT + STRIPE_AI_OVERAGE_PRICE are set (prepaid top-ups still charge).'} />
        {overagePrice && <Row status={overagePriceDetail.includes('metered') ? 'ok' : 'warn'} label="Overage price" detail={overagePriceDetail} />}
      </Card>
    </div>
  );
}
