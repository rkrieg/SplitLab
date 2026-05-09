import { Resend } from 'resend';

const FROM = 'SplitLab <renny@infinitymediala.com>';

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Missing RESEND_API_KEY environment variable');
  return new Resend(key);
}

export async function sendInvitationEmail({
  toName,
  toEmail,
  inviteUrl,
  role,
}: {
  toName: string;
  toEmail: string;
  inviteUrl: string;
  role: string;
}) {
  const resend = getResend();
  const { error } = await resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: "You've been invited to SplitLab",
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 0; }
    .wrapper { max-width: 520px; margin: 40px auto; background: #1e293b; border-radius: 12px; overflow: hidden; }
    .header { background: #3D8BDA; padding: 32px; text-align: center; }
    .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
    .body { padding: 32px; }
    .body p { margin: 0 0 16px; color: #94a3b8; line-height: 1.6; }
    .btn { display: inline-block; background: #3D8BDA; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .footer { text-align: center; padding: 20px 32px; color: #475569; font-size: 12px; border-top: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>SplitLab</h1>
    </div>
    <div class="body">
      <p>Hi ${toName},</p>
      <p>You've been invited to join <strong style="color:#e2e8f0">SplitLab</strong> as a <strong style="color:#e2e8f0; text-transform:capitalize">${role}</strong>. Click below to set your password and get started.</p>

      <p style="text-align:center; margin: 28px 0">
        <a href="${inviteUrl}" class="btn">Set Up Your Account</a>
      </p>

      <p style="font-size:13px; color:#64748b;">This link expires in 7 days. If you weren't expecting this invitation, you can ignore this email.</p>
    </div>
    <div class="footer">SplitLab &mdash; A/B Testing &amp; Landing Page Platform</div>
  </div>
</body>
</html>`,
  });
  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
}

export async function sendVisitorWarningEmail({
  toEmail,
  toName,
  used,
  limit,
  pct,
  planName,
  dashboardUrl,
}: {
  toEmail: string;
  toName: string;
  used: number;
  limit: number;
  pct: number;
  planName: string;
  dashboardUrl: string;
}) {
  const resend = getResend();
  const isNearLimit = pct >= 90;
  const accentColor = isNearLimit ? '#ef4444' : '#f59e0b';
  const subject = isNearLimit
    ? `⚠️ Critical: You've used ${pct}% of your monthly visitor limit`
    : `Heads up: You've used ${pct}% of your monthly visitor limit`;

  const { error } = await resend.emails.send({
    from: FROM,
    to: toEmail,
    subject,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 0; }
    .wrapper { max-width: 520px; margin: 40px auto; background: #1e293b; border-radius: 12px; overflow: hidden; }
    .header { background: ${accentColor}; padding: 32px; text-align: center; }
    .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
    .body { padding: 32px; }
    .body p { margin: 0 0 16px; color: #94a3b8; line-height: 1.6; }
    .meter-wrap { background: #0f172a; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .meter-bar-bg { background: #334155; border-radius: 4px; height: 10px; overflow: hidden; }
    .meter-bar-fill { background: ${accentColor}; height: 10px; border-radius: 4px; width: ${Math.min(pct, 100)}%; }
    .meter-label { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; color: #94a3b8; }
    .btn { display: inline-block; background: #3D8BDA; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .warning-box { background: ${accentColor}18; border: 1px solid ${accentColor}40; border-radius: 8px; padding: 16px; margin: 20px 0; }
    .warning-box p { color: #e2e8f0; margin: 0; font-size: 14px; }
    .footer { text-align: center; padding: 20px 32px; color: #475569; font-size: 12px; border-top: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>SplitLab</h1>
    </div>
    <div class="body">
      <p>Hi ${toName},</p>
      <p>Your account has used <strong style="color:#e2e8f0">${used.toLocaleString()} of ${limit.toLocaleString()} monthly visitors</strong> on the <strong style="color:#e2e8f0">${planName}</strong> plan.</p>

      <div class="meter-wrap">
        <div class="meter-label">
          <span>${used.toLocaleString()} used</span>
          <span>${pct}% of ${limit.toLocaleString()}</span>
        </div>
        <div class="meter-bar-bg">
          <div class="meter-bar-fill"></div>
        </div>
      </div>

      ${isNearLimit ? `
      <div class="warning-box">
        <p><strong>⚠️ Action required:</strong> When you hit 100%, your A/B tests will stop serving traffic and visitors will see a blank page. Upgrade now to keep traffic flowing.</p>
      </div>` : `
      <div class="warning-box">
        <p><strong>Heads up:</strong> You're approaching your monthly limit. Consider upgrading your plan to avoid any interruption to your tests.</p>
      </div>`}

      <p style="text-align:center; margin: 28px 0">
        <a href="${dashboardUrl}/settings" class="btn">Upgrade Plan</a>
      </p>

      <p style="font-size:13px; color:#64748b;">Visitor counts reset on the 1st of each month. If you have questions, reply to this email.</p>
    </div>
    <div class="footer">SplitLab &mdash; A/B Testing &amp; Landing Page Platform</div>
  </div>
</body>
</html>`,
  });
  if (error) {
    console.error('[email] visitor warning error:', error.message);
  }
}

export async function sendVisitorLimitReachedEmail({
  toEmail,
  toName,
  limit,
  planName,
  dashboardUrl,
}: {
  toEmail: string;
  toName: string;
  limit: number;
  planName: string;
  dashboardUrl: string;
}) {
  const resend = getResend();
  const { error } = await resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: '🚨 Your A/B tests are paused — visitor limit reached',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 0; }
    .wrapper { max-width: 520px; margin: 40px auto; background: #1e293b; border-radius: 12px; overflow: hidden; }
    .header { background: #ef4444; padding: 32px; text-align: center; }
    .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
    .body { padding: 32px; }
    .body p { margin: 0 0 16px; color: #94a3b8; line-height: 1.6; }
    .btn { display: inline-block; background: #3D8BDA; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .alert-box { background: #ef444418; border: 1px solid #ef444440; border-radius: 8px; padding: 16px; margin: 20px 0; }
    .alert-box p { color: #fca5a5; margin: 0; font-size: 14px; }
    .footer { text-align: center; padding: 20px 32px; color: #475569; font-size: 12px; border-top: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>SplitLab — Tests Paused</h1>
    </div>
    <div class="body">
      <p>Hi ${toName},</p>

      <div class="alert-box">
        <p><strong>🚨 Your A/B tests have been paused.</strong> You've reached the ${limit.toLocaleString()} visitor limit for your <strong>${planName}</strong> plan this month. Visitors to your custom domains are being redirected to the fallback URL.</p>
      </div>

      <p>Upgrade your plan to immediately resume serving your A/B tests. Visitor counts reset automatically on the 1st of next month.</p>

      <p style="text-align:center; margin: 28px 0">
        <a href="${dashboardUrl}/settings" class="btn">Upgrade Now to Resume</a>
      </p>

      <p style="font-size:13px; color:#64748b;">Need help? Reply to this email and we'll get back to you right away.</p>
    </div>
    <div class="footer">SplitLab &mdash; A/B Testing &amp; Landing Page Platform</div>
  </div>
</body>
</html>`,
  });
  if (error) {
    console.error('[email] visitor limit reached error:', error.message);
  }
}
