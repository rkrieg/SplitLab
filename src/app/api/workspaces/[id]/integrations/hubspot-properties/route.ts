import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { fetchHubSpotProperties, getValidAccessToken } from '@/lib/integrations/hubspot';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';

// GET /api/workspaces/[id]/integrations/hubspot-properties
// Returns all HubSpot contact properties (standard + custom) for the dropdown
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wsRole = await resolveWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data: integration, error } = await db
    .from('workspace_integrations')
    .select('id, config')
    .eq('workspace_id', params.id)
    .eq('type', 'hubspot')
    .eq('enabled', true)
    .single();

  if (error || !integration) {
    return NextResponse.json({ error: 'HubSpot not connected' }, { status: 404 });
  }

  const config = integration.config as { access_token?: string; refresh_token?: string; expires_at?: string };
  if (!config.access_token || !config.refresh_token || !config.expires_at) {
    return NextResponse.json({ error: 'No access token found' }, { status: 400 });
  }

  const accessToken = await getValidAccessToken({ id: integration.id, config: config as { access_token: string; refresh_token: string; expires_at: string } });
  if (!accessToken) {
    return NextResponse.json({ error: 'Failed to obtain valid access token' }, { status: 401 });
  }

  try {
    const properties = await fetchHubSpotProperties(accessToken);
    return NextResponse.json({ properties });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
