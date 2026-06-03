import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { getValidAccessToken } from '@/lib/integrations/hubspot';

export const dynamic = 'force-dynamic';

// POST /api/workspaces/[id]/integrations/verify
// Checks if the stored OAuth token is still valid (refreshes if needed)
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: integration } = await db
    .from('workspace_integrations')
    .select('id, config')
    .eq('workspace_id', params.id)
    .eq('type', 'hubspot')
    .eq('enabled', true)
    .single();

  if (!integration) return NextResponse.json({ ok: false, error: 'Not connected' }, { status: 404 });

  const config = integration.config as { access_token: string; refresh_token: string; expires_at: string };
  const token = await getValidAccessToken({ id: integration.id, config });

  if (!token) return NextResponse.json({ ok: false, error: 'Token refresh failed — please reconnect HubSpot' }, { status: 400 });

  return NextResponse.json({ ok: true });
}
