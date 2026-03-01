import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = 'renny@infinitymediala.com';
const LOGIN_URL = 'https://split-lab-red.vercel.app/login';

export async function sendInvitationEmail({
  toName,
  toEmail,
  temporaryPassword,
  role,
}: {
  toName: string;
  toEmail: string;
  temporaryPassword: string;
  role: string;
}) {
  await resend.emails.send({
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
    .creds { background: #0f172a; border-radius: 8px; padding: 20px; margin: 24px 0; }
    .creds div { margin-bottom: 10px; font-size: 14px; }
    .creds span.label { color: #64748b; display: inline-block; width: 80px; }
    .creds span.value { color: #e2e8f0; font-family: monospace; }
    .btn { display: inline-block; background: #3D8BDA; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; }
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
      <p>You've been invited to join <strong style="color:#e2e8f0">SplitLab</strong> as a <strong style="color:#e2e8f0; text-transform:capitalize">${role}</strong>. Use the credentials below to log in and get started.</p>

      <div class="creds">
        <div><span class="label">Email</span> <span class="value">${toEmail}</span></div>
        <div><span class="label">Password</span> <span class="value">${temporaryPassword}</span></div>
      </div>

      <p style="text-align:center">
        <a href="${LOGIN_URL}" class="btn">Log in to SplitLab</a>
      </p>

      <p style="font-size:13px; color:#64748b; margin-top:24px;">Please change your password after your first login. If you weren't expecting this invitation, you can ignore this email.</p>
    </div>
    <div class="footer">SplitLab &mdash; A/B Testing &amp; Landing Page Platform</div>
  </div>
</body>
</html>`,
  });
}
