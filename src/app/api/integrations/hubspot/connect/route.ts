import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const HUBSPOT_AUTH_URL = 'https://app.hubspot.com/oauth/authorize';

// GET /api/integrations/hubspot/connect?workspaceId=xxx
// Redirects the user to HubSpot OAuth authorization page
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) {
    return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
  }

  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: 'HubSpot OAuth not configured' }, { status: 500 });
  }

  // Encode workspaceId in state so we know which workspace to connect on callback
  const state = Buffer.from(JSON.stringify({ workspaceId })).toString('base64');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'crm.objects.contacts.write crm.schemas.contacts.read',
    state,
  });

  return NextResponse.redirect(`${HUBSPOT_AUTH_URL}?${params.toString()}`);
}
