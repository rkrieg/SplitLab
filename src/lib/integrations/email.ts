import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const LOGO_URL = 'https://www.trysplitlab.com/splitlab-logo-light.png';

export interface EmailConfig {
  recipients: string;  // comma-separated email addresses
  subject: string;
}

export interface EmailSendResult {
  ok: boolean;
  error?: string;
}

function buildEmailHtml(params: {
  testName: string;
  variantName: string;
  formFields: Record<string, string>;
  systemData: {
    ip_address?: string | null;
    submitted_at?: string;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
  };
}): string {
  const { testName, variantName, formFields, systemData } = params;
  const logoSrc = LOGO_URL;

  const fieldRows = Object.entries(formFields)
    .filter(([, v]) => v)
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-weight:600;color:#475569;font-size:13px;width:35%;text-transform:capitalize;">${k.replace(/_/g, ' ')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:13px;">${v}</td>
      </tr>`)
    .join('');

  const utmRows = [
    systemData.utm_source && `<tr><td style="padding:6px 12px;color:#64748b;font-size:12px;width:35%;">UTM Source</td><td style="padding:6px 12px;color:#64748b;font-size:12px;">${systemData.utm_source}</td></tr>`,
    systemData.utm_medium && `<tr><td style="padding:6px 12px;color:#64748b;font-size:12px;">UTM Medium</td><td style="padding:6px 12px;color:#64748b;font-size:12px;">${systemData.utm_medium}</td></tr>`,
    systemData.utm_campaign && `<tr><td style="padding:6px 12px;color:#64748b;font-size:12px;">UTM Campaign</td><td style="padding:6px 12px;color:#64748b;font-size:12px;">${systemData.utm_campaign}</td></tr>`,
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#1e293b;border-radius:12px 12px 0 0;padding:24px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <img src="${logoSrc}" alt="SplitLab" height="40" style="display:block;height:40px;width:auto;" />
              </td>
              <td align="right">
                <span style="display:inline-block;background:#3D8BDA22;border:1px solid #3D8BDA44;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;color:#3D8BDA;letter-spacing:0.5px;">NEW LEAD</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:28px 32px;">

          <!-- Test + Variant info -->
          <p style="margin:0 0 4px 0;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;">Test</p>
          <p style="margin:0 0 16px 0;font-size:20px;font-weight:700;color:#0f172a;">${escapeHtml(testName)}</p>

          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td style="background:#f8fafc;border-radius:8px;padding:10px 14px;border:1px solid #e2e8f0;">
                <span style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.6px;">Variant</span>
                <p style="margin:4px 0 0;font-size:14px;font-weight:600;color:#3D8BDA;">${escapeHtml(variantName)}</p>
              </td>
              <td width="16" />
              <td style="background:#f8fafc;border-radius:8px;padding:10px 14px;border:1px solid #e2e8f0;">
                <span style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.6px;">Submitted</span>
                <p style="margin:4px 0 0;font-size:13px;font-weight:500;color:#334155;">${systemData.submitted_at ? new Date(systemData.submitted_at).toLocaleString() : '—'}</p>
              </td>
            </tr>
          </table>

          <!-- Form fields -->
          ${fieldRows ? `
          <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;">Form Submission</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:24px;">
            ${fieldRows}
          </table>` : ''}

          <!-- UTM info -->
          ${utmRows ? `
          <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;">Traffic Source</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:24px;">
            ${utmRows}
          </table>` : ''}

        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f8fafc;border-radius:0 0 12px 12px;padding:16px 32px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:11px;color:#94a3b8;text-align:center;">
            Sent by <strong style="color:#64748b;">SplitLab</strong> · You received this because email notifications are enabled for this test
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function interpolateSubject(subject: string, variantName: string, testName: string): string {
  return subject
    .replace(/\{\{variant\}\}/gi, variantName)
    .replace(/\{\{test\}\}/gi, testName);
}

export async function sendLeadNotificationEmail(params: {
  config: EmailConfig;
  testName: string;
  variantName: string;
  formFields: Record<string, string>;
  systemData: {
    ip_address?: string | null;
    submitted_at?: string;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
  };
}): Promise<EmailSendResult> {
  const { config, testName, variantName, formFields, systemData } = params;

  if (!process.env.RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }

  const toAddresses = config.recipients
    .split(',')
    .map(e => e.trim())
    .filter(e => e.includes('@'));

  if (toAddresses.length === 0) {
    return { ok: false, error: 'No valid recipient email addresses' };
  }

  const subject = interpolateSubject(
    config.subject || 'New lead: {{test}} - {{variant}}',
    variantName,
    testName,
  );

  try {
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'SplitLab <notifications@trysplitlab.com>',
      to: toAddresses,
      subject,
      html: buildEmailHtml({ testName, variantName, formFields, systemData }),
    });

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
