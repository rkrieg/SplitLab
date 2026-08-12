import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { generateAuthCode } from '@/lib/mcp/tokens';

// Absolute URLs are built from this, never from request.url — a request
// arriving through a tunnel/proxy (ngrok, Vercel preview, etc.) can have a
// Host header the app server doesn't see as canonical, and request.url would
// silently redirect the browser to the wrong origin (e.g. localhost instead
// of the public tunnel URL). Every other absolute-URL builder in this MCP
// layer (mcp/route.ts, pages.ts's publishPage) already follows this rule.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
const AUTH_CODE_TTL_MS = 60_000; // 60s, single-use

interface AuthorizeParams {
  response_type: string | null;
  client_id: string | null;
  redirect_uri: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  state: string | null;
  scope: string | null;
}

function readParams(url: URL): AuthorizeParams {
  return {
    response_type: url.searchParams.get('response_type'),
    client_id: url.searchParams.get('client_id'),
    redirect_uri: url.searchParams.get('redirect_uri'),
    code_challenge: url.searchParams.get('code_challenge'),
    code_challenge_method: url.searchParams.get('code_challenge_method'),
    state: url.searchParams.get('state'),
    scope: url.searchParams.get('scope'),
  };
}

async function validateRequest(p: AuthorizeParams) {
  if (p.response_type !== 'code') return { error: 'unsupported_response_type' as const };
  if (!p.client_id || !p.redirect_uri || !p.code_challenge) return { error: 'invalid_request' as const };
  // PKCE is mandatory per the MCP spec, even for confidential clients.
  if (p.code_challenge_method !== 'S256') return { error: 'invalid_request' as const };

  const { data: client } = await db
    .from('oauth_clients')
    .select('id, client_name, redirect_uris')
    .eq('id', p.client_id)
    .single();

  if (!client) return { error: 'invalid_client' as const };
  if (!client.redirect_uris.includes(p.redirect_uri)) return { error: 'invalid_redirect_uri' as const };

  return { client };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function consentPage(clientName: string, scope: string, formAction: string, hidden: Record<string, string>) {
  const hiddenInputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n      ');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Connect to SplitLab</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0A0E17; color: #E8ECF5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #121826; border: 1px solid #2B3547; border-radius: 12px; padding: 32px; max-width: 420px; width: 90%; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #8993A8; font-size: 14px; line-height: 1.5; }
  .scope { background: #1B2333; border: 1px solid #2B3547; border-radius: 8px; padding: 10px 12px; font-family: monospace; font-size: 12px; margin: 16px 0; }
  .row { display: flex; gap: 10px; margin-top: 20px; }
  button { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #2B3547; font-size: 14px; cursor: pointer; }
  button[name="decision"][value="approve"] { background: #3D8BDA; color: white; border: none; }
  button[name="decision"][value="deny"] { background: transparent; color: #E8ECF5; }
</style></head>
<body>
  <div class="card">
    <h1>${escapeHtml(clientName)} wants to connect to SplitLab</h1>
    <p>It will act as you, with your existing role and permissions.</p>
    <div class="scope">${escapeHtml(scope)}</div>
    <form method="POST" action="${escapeHtml(formAction)}">
      ${hiddenInputs}
      <div class="row">
        <button name="decision" value="deny">Deny</button>
        <button name="decision" value="approve">Allow</button>
      </div>
    </form>
  </div>
</body></html>`;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const p = readParams(url);

  const validated = await validateRequest(p);
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    const loginUrl = new URL('/login', APP_URL);
    loginUrl.searchParams.set('callbackUrl', url.pathname + url.search);
    return NextResponse.redirect(loginUrl);
  }

  const html = consentPage(
    validated.client.client_name,
    p.scope || 'splitlab:read splitlab:write',
    '/api/oauth/authorize',
    {
      client_id: p.client_id as string,
      redirect_uri: p.redirect_uri as string,
      code_challenge: p.code_challenge as string,
      code_challenge_method: p.code_challenge_method as string,
      state: p.state ?? '',
      scope: p.scope || 'splitlab:read splitlab:write',
    }
  );

  return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const form = await request.formData();
  const decision = form.get('decision');
  const p: AuthorizeParams = {
    response_type: 'code',
    client_id: form.get('client_id') as string | null,
    redirect_uri: form.get('redirect_uri') as string | null,
    code_challenge: form.get('code_challenge') as string | null,
    code_challenge_method: form.get('code_challenge_method') as string | null,
    state: (form.get('state') as string | null) || null,
    scope: (form.get('scope') as string | null) || null,
  };

  const validated = await validateRequest(p);
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const redirectUrl = new URL(p.redirect_uri as string);

  if (decision !== 'approve') {
    redirectUrl.searchParams.set('error', 'access_denied');
    if (p.state) redirectUrl.searchParams.set('state', p.state);
    // 303, not the NextResponse.redirect() default of 307 — this redirect is
    // a response to the consent form's POST, but the destination is the
    // OAuth client's callback URL, which expects a plain GET. A 307 would
    // preserve POST across the redirect and the client's callback handler
    // (e.g. Claude's) rejects that with 405 Method Not Allowed.
    return NextResponse.redirect(redirectUrl, 303);
  }

  const code = generateAuthCode();
  const { error } = await db.from('oauth_authorization_codes').insert({
    code,
    client_id: p.client_id,
    user_id: session.user.id,
    redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge,
    code_challenge_method: p.code_challenge_method,
    scope: p.scope || 'splitlab:read splitlab:write',
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  redirectUrl.searchParams.set('code', code);
  if (p.state) redirectUrl.searchParams.set('state', p.state);
  return NextResponse.redirect(redirectUrl, 303);
}
