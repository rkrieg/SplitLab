import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';

export async function POST(request: NextRequest) {
  const { name, email, message } = await request.json();

  if (!name || !email || !message) {
    return NextResponse.json({ error: 'All fields are required' }, { status: 400 });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return NextResponse.json({ error: 'Email service not configured' }, { status: 500 });
  }

  const resend = new Resend(key);
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'SplitLab <notifications@trysplitlab.com>',
    to: process.env.RESEND_CONTACT_TO || 'notifications@trysplitlab.com',
    replyTo: email,
    subject: `[SplitLab Support] Message from ${name}`,
    html: `
      <div style="font-family: sans-serif; max-width: 520px;">
        <h2 style="margin: 0 0 16px;">New Contact Form Submission</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
        <p style="white-space: pre-wrap;">${message}</p>
      </div>
    `,
  });

  if (error) {
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
