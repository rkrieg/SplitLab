import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { Resend } from 'resend';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  const { email } = await request.json();
  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  }

  // Always return success to prevent email enumeration
  const successResponse = NextResponse.json({ ok: true });

  const { data: user } = await db
    .from('users')
    .select('id, name, email')
    .eq('email', email.toLowerCase())
    .eq('status', 'active')
    .single();

  if (!user) return successResponse;

  // Generate a reset token (expires in 1 hour)
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const { error: upsertError } = await db
    .from('password_resets')
    .upsert({ user_id: user.id, token, expires_at: expiresAt }, { onConflict: 'user_id' });

  if (upsertError) {
    console.error('Failed to save reset token:', upsertError);
    return successResponse;
  }

  // Send reset email
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('Missing RESEND_API_KEY');
    return successResponse;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
  const resetLink = `${appUrl}/reset-password?token=${token}`;

  const resend = new Resend(key);
  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'SplitLab <notifications@trysplitlab.com>',
    to: user.email,
    subject: 'SplitLab — Reset your password',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 0; }
    .wrapper { max-width: 520px; margin: 40px auto; background: #1e293b; border-radius: 12px; overflow: hidden; }
    .header { background: #3D8BDA; padding: 32px; text-align: center; }
    .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 700; }
    .body { padding: 32px; }
    .body p { margin: 0 0 16px; color: #94a3b8; line-height: 1.6; }
    .btn { display: inline-block; background: #3D8BDA; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .footer { text-align: center; padding: 20px 32px; color: #475569; font-size: 12px; border-top: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header"><h1>SplitLab</h1></div>
    <div class="body">
      <p>Hi ${user.name},</p>
      <p>We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.</p>
      <p style="text-align:center; margin: 28px 0;">
        <a href="${resetLink}" class="btn">Reset Password</a>
      </p>
      <p style="font-size:13px; color:#64748b;">If you didn't request this, you can safely ignore this email.</p>
    </div>
    <div class="footer">SplitLab &mdash; A/B Testing &amp; Landing Page Platform</div>
  </div>
</body>
</html>`,
  });

  return successResponse;
}
