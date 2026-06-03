import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { syncLeadToHubSpot, getValidAccessToken } from '@/lib/integrations/hubspot';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { testId, variantId, visitorHash, formFields, utm } = body as {
    testId?: string;
    variantId?: string;
    visitorHash?: string;
    formFields?: Record<string, string>;
    utm?: Record<string, string>;
  };

  if (!testId || typeof testId !== 'string') {
    return NextResponse.json({ error: 'Missing testId' }, { status: 400 });
  }

  // Verify test exists and get workspace_id for integration lookup
  const { data: test } = await db
    .from('tests')
    .select('id, workspace_id')
    .eq('id', testId)
    .single();
  if (!test) {
    return NextResponse.json({ error: 'Test not found' }, { status: 404 });
  }

  // Reject empty form submissions
  if (!formFields || Object.keys(formFields).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null;

  const submittedAt = new Date().toISOString();

  const { error } = await db.from('form_leads').insert({
    test_id:      testId,
    variant_id:   variantId || null,
    visitor_hash: visitorHash || null,
    ip_address:   ip,
    user_agent:   request.headers.get('user-agent') || null,
    utm_source:   utm?.utm_source || null,
    utm_medium:   utm?.utm_medium || null,
    utm_content:  utm?.utm_content || null,
    utm_term:     utm?.utm_term || null,
    utm_campaign: utm?.utm_campaign || null,
    gclid:        utm?.gclid || null,
    form_fields:  formFields || {},
  });

  if (error) {
    console.error('[form-leads] insert error', error);
    return NextResponse.json({ error: 'Failed to save lead' }, { status: 500 });
  }

  // Fire-and-forget HubSpot sync — does not block the response
  syncLeadToHubSpotBackground({
    testId,
    workspaceId: test.workspace_id,
    variantId: variantId ?? null,
    formFields: formFields ?? {},
    systemData: {
      ip_address:   ip,
      submitted_at: submittedAt,
      utm_source:   utm?.utm_source ?? null,
      utm_medium:   utm?.utm_medium ?? null,
      utm_campaign: utm?.utm_campaign ?? null,
      utm_content:  utm?.utm_content ?? null,
      utm_term:     utm?.utm_term ?? null,
      gclid:        utm?.gclid ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}

async function syncLeadToHubSpotBackground(params: {
  testId: string;
  workspaceId: string;
  variantId: string | null;
  formFields: Record<string, string>;
  systemData: {
    ip_address?: string | null;
    submitted_at?: string;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
    gclid?: string | null;
  };
}) {
  try {
    // Get HubSpot integration for this workspace
    const { data: integration } = await db
      .from('workspace_integrations')
      .select('id, config')
      .eq('workspace_id', params.workspaceId)
      .eq('type', 'hubspot')
      .eq('enabled', true)
      .single();

    if (!integration) return;

    const config = integration.config as { access_token: string; refresh_token: string; expires_at: string };
    if (!config.access_token) return;

    // Auto-refresh token if expired
    const accessToken = await getValidAccessToken({ id: integration.id, config });
    if (!accessToken) return;

    // Get test-level mapping (must be enabled)
    const { data: mapping } = await db
      .from('test_integration_mappings')
      .select('id, field_mappings')
      .eq('test_id', params.testId)
      .eq('workspace_integration_id', integration.id)
      .eq('enabled', true)
      .single();

    if (!mapping || !mapping.field_mappings) return;

    // Get variant name for the "variant" system field
    let variantName: string | undefined;
    if (params.variantId) {
      const { data: variant } = await db
        .from('test_variants')
        .select('name')
        .eq('id', params.variantId)
        .single();
      variantName = variant?.name;
    }

    const result = await syncLeadToHubSpot({
      accessToken,
      fieldMappings: mapping.field_mappings as Record<string, string>,
      formFields: params.formFields,
      systemData: { ...params.systemData, variantName },
    });

    if (result.ok) {
      await db.rpc('increment_integration_synced', { p_mapping_id: mapping.id });
    } else {
      console.error('[hubspot-sync] failed:', result.error);
      await db.rpc('increment_integration_failed', { p_mapping_id: mapping.id });
    }
  } catch (err) {
    console.error('[hubspot-sync] unexpected error:', err);
  }
}
