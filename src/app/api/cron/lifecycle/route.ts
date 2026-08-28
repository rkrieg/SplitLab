import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { sendLifecycleEmail, renderEmail } from '@/lib/email/lifecycle';
import { DRIP_STEPS, type DripCtx } from '@/lib/email/drips';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const APP = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
const DAY = 86_400_000;

// GET /api/cron/lifecycle — daily. Evaluates each account owner's state and
// sends the drip step / behavior email that's due. DRY-RUN by default: it runs
// every preference + de-dupe check and reports what it WOULD send, but sends
// nothing until CRON_LIFECYCLE_SEND=true (or ?send=1 with the cron secret).
export async function GET(req: NextRequest) {
  // Auth: Vercel Cron sends `x-vercel-cron`, or Authorization: Bearer <CRON_SECRET>.
  const secret = process.env.CRON_SECRET;
  const authed = req.headers.get('x-vercel-cron') != null
    || (secret && req.headers.get('authorization') === `Bearer ${secret}`);
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dryRun = !(process.env.CRON_LIFECYCLE_SEND === 'true' || req.nextUrl.searchParams.get('send') === '1');
  const now = Date.now();

  // Bulk-load the state we need (avoids per-user N+1).
  const [{ data: clients }, { data: workspaces }, { data: tests }, { data: domains }] = await Promise.all([
    db.from('clients').select('id, owner_id'),
    db.from('workspaces').select('id, client_id'),
    db.from('tests').select('workspace_id, status'),
    db.from('domains').select('workspace_id, verified'),
  ]);

  const wsHasTest = new Set<string>();
  const wsHasActive = new Set<string>();
  for (const t of tests ?? []) { wsHasTest.add(t.workspace_id); if (t.status === 'active') wsHasActive.add(t.workspace_id); }
  const wsHasDomain = new Set<string>();
  for (const d of domains ?? []) { if (d.verified) wsHasDomain.add(d.workspace_id); }
  const clientWorkspaces = new Map<string, string[]>();
  for (const w of workspaces ?? []) { const a = clientWorkspaces.get(w.client_id) ?? []; a.push(w.id); clientWorkspaces.set(w.client_id, a); }
  const ownerClients = new Map<string, string[]>();
  for (const c of clients ?? []) { if (!c.owner_id) continue; const a = ownerClients.get(c.owner_id) ?? []; a.push(c.id); ownerClients.set(c.owner_id, a); }

  const ownerIds = Array.from(ownerClients.keys());
  const { data: users } = ownerIds.length
    ? await db.from('users').select('id, email, name, plan, created_at, last_login_at').in('id', ownerIds)
    : { data: [] };

  const report: { userId: string; email: string; key: string; result: string }[] = [];

  for (const u of users ?? []) {
    if (!u.email || !u.created_at) continue;
    const daysSinceSignup = Math.floor((now - new Date(u.created_at).getTime()) / DAY);
    const track: 'free' | 'paid' = (u.plan ?? 'free') === 'free' ? 'free' : 'paid';
    const firstName = ((u.name as string) || '').split(' ')[0] || 'there';
    const planName = track === 'paid' ? String(u.plan).charAt(0).toUpperCase() + String(u.plan).slice(1) : 'Free';

    // Aggregate test/domain state across the owner's workspaces.
    const wsIds = (ownerClients.get(u.id) ?? []).flatMap(cid => clientWorkspaces.get(cid) ?? []);
    const ctx: DripCtx = {
      firstName, planName,
      hasTest: wsIds.some(id => wsHasTest.has(id)),
      hasActiveTest: wsIds.some(id => wsHasActive.has(id)),
      hasVerifiedDomain: wsIds.some(id => wsHasDomain.has(id)),
    };

    // ── Time-based drip steps due today ──
    for (const step of DRIP_STEPS) {
      if (step.track !== track) continue;
      if (step.day !== daysSinceSignup) continue;
      if (step.when && !step.when(ctx)) continue;
      const result = await sendLifecycleEmail({
        userId: u.id, to: u.email, emailKey: step.key, klass: 'lifecycle',
        subject: step.subject(ctx), html: step.html(ctx), dryRun,
      });
      if (result !== 'skipped') report.push({ userId: u.id, email: u.email, key: step.key, result });
    }

    // ── Behavior triggers (paid retention) ──
    if (track === 'paid') {
      const daysSinceLogin = u.last_login_at ? Math.floor((now - new Date(u.last_login_at).getTime()) / DAY) : null;
      if (daysSinceSignup === 7 && !ctx.hasTest) {
        const r = await sendLifecycleEmail({ userId: u.id, to: u.email, emailKey: 'paid.no_test_wk1', klass: 'lifecycle',
          subject: "Let's get your first test live",
          html: renderEmail({ heading: "Let's get your first test live", bodyHtml: `<p>You're on ${planName} but haven't launched a test yet — let's fix that. Want us to set the first one up with you? Just reply.</p>`, button: { label: 'Create a test', url: `${APP}/dashboard` }, showUnsubscribe: true }), dryRun });
        if (r !== 'skipped') report.push({ userId: u.id, email: u.email, key: 'paid.no_test_wk1', result: r });
      }
      if (daysSinceLogin === 7) {
        const r = await sendLifecycleEmail({ userId: u.id, to: u.email, emailKey: 'paid.no_login_7', klass: 'lifecycle',
          subject: 'Your tests are running — here\'s what\'s happening',
          html: renderEmail({ heading: 'Here\'s your pulse', bodyHtml: `<p>A quick pulse on your live tests so you don't have to log in to stay in the loop.</p>`, button: { label: 'View dashboard', url: `${APP}/dashboard` }, showUnsubscribe: true }), dryRun });
        if (r !== 'skipped') report.push({ userId: u.id, email: u.email, key: 'paid.no_login_7', result: r });
      }
      if (daysSinceLogin === 14) {
        const r = await sendLifecycleEmail({ userId: u.id, to: u.email, emailKey: 'paid.no_login_14', klass: 'lifecycle',
          subject: 'Anything we can help with?',
          html: renderEmail({ heading: 'Anything we can help with?', bodyHtml: `<p>Noticed you haven't been in for a couple weeks, ${firstName}. Anything blocking you? Reply and we'll help.</p>`, button: { label: 'Open dashboard', url: `${APP}/dashboard` }, showUnsubscribe: true }), dryRun });
        if (r !== 'skipped') report.push({ userId: u.id, email: u.email, key: 'paid.no_login_14', result: r });
      }
    }
  }

  const sent = report.filter(r => r.result === 'sent').length;
  return NextResponse.json({
    dryRun, evaluated: users?.length ?? 0,
    [dryRun ? 'wouldSend' : 'sent']: sent,
    detail: report,
  });
}
