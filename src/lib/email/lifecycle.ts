import { Resend } from 'resend';
import crypto from 'crypto';
import { db } from '@/lib/supabase-server';

const resend = new Resend(process.env.RESEND_API_KEY);
const LOGO_URL = 'https://www.trysplitlab.com/splitlab-logo-light.png';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

// From addresses. Lifecycle/marketing vs operational alerts. Override via env.
// The from-domain MUST be verified in Resend.
// hello@trysplitlab.com is a real monitored mailbox, so everything sends from and
// replies to it — one inbox, no env vars required (all overridable via env).
const FROM_LIFECYCLE = process.env.RESEND_FROM_LIFECYCLE || 'SplitLab <hello@trysplitlab.com>';
const FROM_ALERTS = process.env.RESEND_FROM_ALERTS || 'SplitLab <hello@trysplitlab.com>';
const REPLY_TO = process.env.RESEND_REPLY_TO || 'hello@trysplitlab.com';

// One-click unsubscribe: a signed token so the link works from the email with no
// login (RFC 8058). Keyed on NEXTAUTH_SECRET.
const UNSUB_SECRET = process.env.NEXTAUTH_SECRET || 'splitlab-unsub';
export function unsubToken(userId: string): string {
  return crypto.createHmac('sha256', UNSUB_SECRET).update(`unsub:${userId}`).digest('hex').slice(0, 40);
}
export function verifyUnsubToken(userId: string, token: string): boolean {
  const expected = unsubToken(userId);
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token)); } catch { return false; }
}
function unsubUrl(userId: string): string {
  return `${APP_URL}/api/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubToken(userId)}`;
}

/**
 * Which class an email is, which decides preference-gating + from-address:
 * - 'lifecycle'     → Series 1 & 2 drips (gated by email_preferences.lifecycle)
 * - 'activity_win'  → 🎉 wins (gated by email_preferences.activity_wins)
 * - 'digest'        → weekly digest (gated by email_preferences.weekly_digest)
 * - 'operational'   → critical alerts (always send unless unsubscribed_all)
 */
export type EmailClass = 'lifecycle' | 'activity_win' | 'digest' | 'operational';

const PREF_COLUMN: Record<Exclude<EmailClass, 'operational'>, 'lifecycle' | 'activity_wins' | 'weekly_digest'> = {
  lifecycle: 'lifecycle',
  activity_win: 'activity_wins',
  digest: 'weekly_digest',
};

interface EmailButton { label: string; url: string }

/** Branded HTML wrapper shared by every lifecycle/activity email. */
export function renderEmail(params: {
  preheader?: string;
  heading: string;
  bodyHtml: string;        // inner HTML (paragraphs already marked up)
  button?: EmailButton;
  footerNote?: string;
  showUnsubscribe?: boolean; // marketing-class emails must pass true
  unsubscribeUrl?: string;
}): string {
  const { preheader, heading, bodyHtml, button, footerNote, showUnsubscribe, unsubscribeUrl } = params;
  const btn = button
    ? `<table cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:10px;background:#3D8BDA;">
         <a href="${button.url}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:10px;">${button.label}</a>
       </td></tr></table>`
    : '';
  const unsub = showUnsubscribe
    ? `<p style="margin:16px 0 0;color:#94a3b8;font-size:11px;line-height:1.6;">You're receiving this because you have a SplitLab account.
        <a href="${unsubscribeUrl || `${APP_URL}/settings/notifications`}" style="color:#94a3b8;text-decoration:underline;">Manage email preferences</a>.<br/>SplitLab</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>` : ''}
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#1e293b;border-radius:12px 12px 0 0;padding:20px 32px;">
        <img src="${LOGO_URL}" alt="SplitLab" height="34" style="display:block;height:34px;width:auto;" />
      </td></tr>
      <tr><td style="background:#ffffff;padding:32px;">
        <h1 style="margin:0 0 16px;color:#0f172a;font-size:20px;line-height:1.3;">${heading}</h1>
        <div style="color:#334155;font-size:15px;line-height:1.6;">${bodyHtml}</div>
        ${btn}
        ${footerNote ? `<p style="margin:20px 0 0;color:#64748b;font-size:13px;line-height:1.6;">${footerNote}</p>` : ''}
      </td></tr>
      <tr><td style="background:#ffffff;border-radius:0 0 12px 12px;padding:0 32px 28px;">${unsub}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

/**
 * Send a lifecycle/activity/operational email, with de-dupe and preference
 * gating baked in. Returns 'sent' | 'skipped' | 'error'. Never throws.
 *
 * De-dupe:
 *   - recurringDays omitted → one-time: skip if this email_key was ever sent to the user.
 *   - recurringDays = N     → skip if sent within the last N days (used for cap/no-login nudges).
 */
export async function sendLifecycleEmail(params: {
  userId: string | null;
  to: string;
  emailKey: string;
  klass: EmailClass;
  subject: string;
  html: string;
  recurringDays?: number;
  /** When true, run all preference/de-dupe checks but DON'T send or log — used
   *  by the cron's dry-run so you can preview exactly who would get what. */
  dryRun?: boolean;
}): Promise<'sent' | 'skipped' | 'error'> {
  const { userId, to, emailKey, klass, subject, html, recurringDays, dryRun } = params;
  if (!process.env.RESEND_API_KEY || !to) return 'skipped';

  try {
    // Preference gating (userId required to read prefs; operational bypasses category gate).
    if (userId) {
      const { data: pref } = await db
        .from('email_preferences')
        .select('lifecycle, activity_wins, weekly_digest, unsubscribed_all')
        .eq('user_id', userId)
        .maybeSingle();
      if (pref) {
        if (pref.unsubscribed_all && klass !== 'operational') return 'skipped';
        if (klass !== 'operational') {
          const col = PREF_COLUMN[klass];
          if (pref[col] === false) return 'skipped';
        }
      }
    }

    // De-dupe / cadence.
    if (userId) {
      const { data: last } = await db
        .from('email_log')
        .select('sent_at')
        .eq('user_id', userId)
        .eq('email_key', emailKey)
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (last) {
        if (recurringDays == null) return 'skipped'; // one-time already sent
        const ageDays = (Date.now() - new Date(last.sent_at).getTime()) / 86_400_000;
        if (ageDays < recurringDays) return 'skipped';
      }
    }

    // Dry-run: all gates passed, so this WOULD send — report it without sending/logging.
    if (dryRun) return 'sent';

    const isMarketing = klass !== 'operational';
    const { error } = await resend.emails.send({
      from: klass === 'operational' ? FROM_ALERTS : FROM_LIFECYCLE,
      to,
      ...(REPLY_TO ? { replyTo: REPLY_TO } : {}),
      subject,
      html,
      ...(isMarketing && userId ? {
        headers: {
          'List-Unsubscribe': `<${unsubUrl(userId)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      } : {}),
    });
    if (error) { console.error(`[email:${emailKey}] send failed:`, error); return 'error'; }

    await db.from('email_log').insert({ user_id: userId, email_key: emailKey, to_email: to });
    return 'sent';
  } catch (err) {
    console.error(`[email:${emailKey}] unexpected error:`, err);
    return 'error';
  }
}
