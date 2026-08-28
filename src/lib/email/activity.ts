import { db } from '@/lib/supabase-server';
import { renderEmail, sendLifecycleEmail } from './lifecycle';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

/**
 * Activity & alert emails (Series 3). Each is fire-and-forget: call from the
 * event's code path (ideally inside waitUntil / without awaiting the request).
 * Recipient = the account owner of the workspace. All resolve the owner + send
 * via the preference-gated, de-duped engine.
 */

type Owner = { userId: string; email: string; name: string; clientId: string };

async function resolveOwner(workspaceId: string): Promise<Owner | null> {
  const { data: ws } = await db.from('workspaces').select('client_id').eq('id', workspaceId).single();
  if (!ws?.client_id) return null;
  const { data: client } = await db.from('clients').select('owner_id').eq('id', ws.client_id).single();
  if (!client?.owner_id) return null;
  const { data: user } = await db.from('users').select('id, email, name').eq('id', client.owner_id).single();
  if (!user?.email) return null;
  return { userId: user.id, email: user.email, name: (user.name as string) ?? '', clientId: ws.client_id };
}

const testUrl = (clientId: string, testId: string) => `${APP_URL}/clients/${clientId}/tests/${testId}`;

// ─── 🎉 Wins (activity_win class — celebratory, preference-gated) ───────────────

export async function notifyPagePublished(p: { workspaceId: string; testId: string; pageName: string; liveUrl?: string }) {
  const o = await resolveOwner(p.workspaceId); if (!o) return;
  const html = renderEmail({
    preheader: `${p.pageName} is live`,
    heading: `🎉 ${p.pageName} is live`,
    bodyHtml: `<p>Nice — <strong>${p.pageName}</strong> just went live${p.liveUrl ? ` at <a href="${p.liveUrl}">${p.liveUrl}</a>` : ''} and is ready to take real traffic.</p><p>Once visitors start arriving, you'll see views, conversions, and a winner emerge right in your dashboard.</p>`,
    button: { label: 'View the test', url: testUrl(o.clientId, p.testId) },
    showUnsubscribe: true,
  });
  return sendLifecycleEmail({ userId: o.userId, to: o.email, emailKey: `act.page_published:${p.testId}`, klass: 'activity_win', subject: `🎉 ${p.pageName} is live`, html });
}

export async function notifyVariantLive(p: { workspaceId: string; testId: string; testName: string; variantName: string }) {
  const o = await resolveOwner(p.workspaceId); if (!o) return;
  const html = renderEmail({
    preheader: `A new variant is live on ${p.testName}`,
    heading: `A new variant just went live`,
    bodyHtml: `<p><strong>${p.variantName}</strong> is now serving traffic on <strong>${p.testName}</strong>. May the best variant win.</p>`,
    button: { label: 'Watch the results', url: testUrl(o.clientId, p.testId) },
    showUnsubscribe: true,
  });
  // No test-scoped de-dupe key here — a variant-live email per variant.
  return sendLifecycleEmail({ userId: o.userId, to: o.email, emailKey: `act.variant_live:${p.testId}:${p.variantName}`, klass: 'activity_win', subject: `A new variant just went live on ${p.testName}`, html });
}

export async function notifyFirstConversion(p: { workspaceId: string; testId: string; testName: string }) {
  const o = await resolveOwner(p.workspaceId); if (!o) return;
  const html = renderEmail({
    preheader: `First conversion on ${p.testName}`,
    heading: `You got your first conversion 🎯`,
    bodyHtml: `<p><strong>${p.testName}</strong> just recorded its first conversion. The tracking is working and the data is flowing.</p><p>Let it run across a full business cycle before calling a winner — early leads often reverse.</p>`,
    button: { label: 'See conversions', url: testUrl(o.clientId, p.testId) },
    showUnsubscribe: true,
  });
  return sendLifecycleEmail({ userId: o.userId, to: o.email, emailKey: `act.first_conversion:${p.testId}`, klass: 'activity_win', subject: `You got your first conversion on ${p.testName}` , html });
}

export async function notifySignificance(p: { workspaceId: string; testId: string; testName: string; winnerName: string; confidence: number; upliftPct?: number }) {
  const o = await resolveOwner(p.workspaceId); if (!o) return;
  const uplift = p.upliftPct != null ? ` (${p.upliftPct > 0 ? '+' : ''}${p.upliftPct}% vs control)` : '';
  const html = renderEmail({
    preheader: `${p.testName} has a significant winner`,
    heading: `📈 You have a statistically significant winner`,
    bodyHtml: `<p><strong>${p.winnerName}</strong> is winning <strong>${p.testName}</strong> at <strong>${p.confidence}% confidence</strong>${uplift}.</p><p>That's above the 95% bar, so you can trust it. Ship it as the new control — or dig into the device split first to be sure it holds everywhere.</p>`,
    button: { label: 'Review and ship the winner', url: testUrl(o.clientId, p.testId) },
    showUnsubscribe: true,
  });
  return sendLifecycleEmail({ userId: o.userId, to: o.email, emailKey: `act.significance:${p.testId}`, klass: 'activity_win', subject: `📈 ${p.testName} has a winner (${p.confidence}% confidence)`, html });
}

export async function notifyTrafficMilestone(p: { workspaceId: string; testId: string; testName: string; visitors: number }) {
  const o = await resolveOwner(p.workspaceId); if (!o) return;
  const html = renderEmail({
    preheader: `${p.testName} passed ${p.visitors.toLocaleString()} visitors`,
    heading: `${p.testName} just passed ${p.visitors.toLocaleString()} visitors`,
    bodyHtml: `<p>Momentum. The more traffic you send, the faster a real winner emerges.</p>`,
    button: { label: 'Check the numbers', url: testUrl(o.clientId, p.testId) },
    showUnsubscribe: true,
  });
  return sendLifecycleEmail({ userId: o.userId, to: o.email, emailKey: `act.traffic_milestone:${p.testId}:${p.visitors}`, klass: 'activity_win', subject: `${p.testName} passed ${p.visitors.toLocaleString()} visitors`, html });
}

// ─── ⚠️ Operational alerts (operational class — always send) ────────────────────

export async function notifyDomainVerified(p: { workspaceId: string; domain: string }) {
  const o = await resolveOwner(p.workspaceId); if (!o) return;
  const html = renderEmail({
    preheader: `${p.domain} is verified`,
    heading: `Your domain ${p.domain} is verified`,
    bodyHtml: `<p>DNS checks out — you can now serve tests on <strong>${p.domain}</strong>.</p>`,
    button: { label: 'Open Domains', url: `${APP_URL}/clients/${o.clientId}/domains` },
  });
  return sendLifecycleEmail({ userId: o.userId, to: o.email, emailKey: `ops.domain_verified:${p.domain}`, klass: 'operational', subject: `Your domain ${p.domain} is verified`, html });
}

export async function notifyDomainFailed(p: { workspaceId: string; domain: string }) {
  const o = await resolveOwner(p.workspaceId); if (!o) return;
  const html = renderEmail({
    preheader: `Action needed: ${p.domain} isn't verified`,
    heading: `Action needed: ${p.domain} isn't verified`,
    bodyHtml: `<p>We couldn't verify <strong>${p.domain}</strong> — its DNS records don't look right yet, so tests won't serve on it. Double-check the records in your DNS provider.</p>`,
    button: { label: 'Fix the domain', url: `${APP_URL}/clients/${o.clientId}/domains` },
  });
  return sendLifecycleEmail({ userId: o.userId, to: o.email, emailKey: `ops.domain_failed:${p.domain}`, klass: 'operational', subject: `Action needed: ${p.domain} isn't verified`, html, recurringDays: 3 });
}

/** Free-plan visitor cap warnings — escalating, framed on the real consequence
 *  (tracking stops), NOT a fake shutdown. stage: 1 = first, 2 = 24h, 3 = recurring. */
export async function notifyCapWarning(p: { userId: string; email: string; clientId?: string; stage: 1 | 2 | 3; daysBlind?: number }) {
  const upgradeUrl = `${APP_URL}/billing`;
  const common = { button: { label: 'Upgrade now', url: upgradeUrl }, showUnsubscribe: true } as const;
  let subject: string, heading: string, body: string, key: string, recurringDays: number | undefined;
  if (p.stage === 1) {
    key = 'free.cap_warn_1'; recurringDays = undefined;
    subject = '⚠️ Your test just stopped recording data';
    heading = 'Your test just stopped recording data';
    body = `<p>You've hit your free traffic limit, so SplitLab has <strong>stopped counting new visitors and conversions</strong>. Your test is running blind right now — every visitor you send is going untracked.</p><p>Upgrade in the next 24 hours to resume tracking before you lose more data you can't get back.</p>`;
  } else if (p.stage === 2) {
    key = 'free.cap_warn_2'; recurringDays = undefined;
    subject = 'Last warning: your test is still blind';
    heading = 'Last warning: your test is still blind';
    body = `<p>You're still over the free limit and still recording <strong>nothing</strong>. You can't tell what's working, what's converting, or which variant to ship.</p><p>One upgrade turns tracking back on instantly.</p>`;
  } else {
    key = 'free.cap_warn_recurring'; recurringDays = 3;
    subject = `You've been flying blind for ${p.daysBlind ?? 'several'} days`;
    heading = `Still not tracking — you're losing data daily`;
    body = `<p>Your test has been over the free limit${p.daysBlind ? ` for ${p.daysBlind} days` : ''}, so no new visitors or conversions are being recorded. That's ${p.daysBlind ? `${p.daysBlind} days` : 'days'} of decisions you're making blind.</p>`;
  }
  const html = renderEmail({ preheader: subject, heading, bodyHtml: body, ...common });
  return sendLifecycleEmail({ userId: p.userId, to: p.email, emailKey: key, klass: 'lifecycle', subject, html, recurringDays });
}

export async function notifyPaymentFailed(p: { userId: string; email: string }) {
  const html = renderEmail({
    preheader: `Your payment didn't go through`,
    heading: `Your payment didn't go through`,
    bodyHtml: `<p>We couldn't process your latest SplitLab payment. Update your card to keep your plan active — your tests keep serving in the meantime.</p>`,
    button: { label: 'Update billing', url: `${APP_URL}/billing` },
  });
  return sendLifecycleEmail({ userId: p.userId, to: p.email, emailKey: 'ops.payment_failed', klass: 'operational', subject: `Your SplitLab payment didn't go through`, html, recurringDays: 2 });
}
