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
