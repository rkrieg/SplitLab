import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

// GET /api/integrations/hubspot/callback?code=xxx&state=xxx
// HubSpot redirects here after user approves. We exchange the code for tokens.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.redirect(new URL('/login', req.url));

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const error = req.nextUrl.searchParams.get('error');

  // User denied access on HubSpot side
  if (error) {
    return NextResponse.redirect(new URL('/dashboard?hs_error=access_denied', req.url));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL('/dashboard?hs_error=missing_params', req.url));
  }

  // Decode workspaceId from state
  let workspaceId: string;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf-8')) as { workspaceId: string };
    workspaceId = decoded.workspaceId;
  } catch {
    return NextResponse.redirect(new URL('/dashboard?hs_error=invalid_state', req.url));
  }

  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(new URL('/dashboard?hs_error=not_configured', req.url));
  }

  // Exchange code for tokens
  let tokenData: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    hub_id?: number;
  };

  try {
    const res = await fetch(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('[hubspot callback] token exchange failed:', body);
      return NextResponse.redirect(new URL('/dashboard?hs_error=token_exchange_failed', req.url));
    }

    tokenData = await res.json() as typeof tokenData;
  } catch (err) {
    console.error('[hubspot callback] fetch error:', err);
    return NextResponse.redirect(new URL('/dashboard?hs_error=network_error', req.url));
  }

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

  // Get workspace to find which client/test page to redirect back to
  const { data: workspace } = await db
    .from('workspaces')
    .select('id, client_id')
    .eq('id', workspaceId)
    .single();

  // Save tokens — SELECT then INSERT or UPDATE (upsert avoided: unique constraint dropped for multi-webhook support)
  const newConfig = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: expiresAt,
    hub_id: tokenData.hub_id ?? null,
  };

  const { data: existingHs } = await db
    .from('workspace_integrations')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('type', 'hubspot')
    .single();

  let dbError;
  if (existingHs) {
    ({ error: dbError } = await db
      .from('workspace_integrations')
      .update({ config: newConfig, enabled: true })
      .eq('id', existingHs.id));
  } else {
    ({ error: dbError } = await db
      .from('workspace_integrations')
      .insert({ workspace_id: workspaceId, type: 'hubspot', config: newConfig, enabled: true }));
  }

  if (dbError) {
    console.error('[hubspot callback] db error:', dbError);
    return NextResponse.redirect(new URL('/dashboard?hs_error=db_error', req.url));
  }

  // Redirect back to the client's integrations tab
  const redirectTo = workspace?.client_id
    ? `/clients/${workspace.client_id}?tab=integrations&hs_connected=1`
    : '/dashboard?hs_connected=1';

  return NextResponse.redirect(new URL(redirectTo, req.url));
}
