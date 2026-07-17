import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { db } from '@/lib/supabase-server';
import { syncLeadToHubSpot, getValidAccessToken } from '@/lib/integrations/hubspot';
import { sendLeadNotificationEmail, type EmailConfig } from '@/lib/integrations/email';
import { fireWebhook, type WebhookConfig, type WebhookFieldMappings } from '@/lib/integrations/webhook';

export const dynamic = 'force-dynamic';

// Next.js route segment config — picked up automatically by the build, not called/imported
// anywhere. Sets the hard timeout for this route's serverless function specifically.
// Hard timeout for this invocation, including the waitUntil-kept-alive background dispatch below.
// If still running when this hits, Vercel kills it mid-execution regardless of what it's doing —
// worst case here (expired HubSpot token refresh + retries, then form-submit retries) can stack
// up to ~10-12s, so 60s leaves comfortable headroom without holding instances open unnecessarily.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { testId, variantId, visitorHash, formFields, utm, pageUrl, pageTitle, hutk } = body as {
    testId?: string;
    variantId?: string;
    visitorHash?: string;
    formFields?: Record<string, string>;
    utm?: Record<string, string>;
    pageUrl?: string;
    pageTitle?: string;
    hutk?: string;
  };

  if (!testId || typeof testId !== 'string') {
    return NextResponse.json({ error: 'Missing testId' }, { status: 400 });
  }

  // Verify test exists and get workspace_id + name for integration lookup
  const { data: test } = await db
    .from('tests')
    .select('id, name, workspace_id')
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

  // Public endpoint — anything can POST here, so don't trust these through to the DB
  // or on to HubSpot. Cap length: HubSpot rejects an over-long pageUri outright.
  const clean = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const pageUrlClean = clean(pageUrl, 2048);
  const pageTitleClean = clean(pageTitle, 255);
  // HubSpot visitor token (hubspotutk cookie, a 32-char hex value). Only forwarded
  // to HubSpot as context.hutk — never stored. Strict shape check since this is
  // attacker-controllable input.
  const hutkClean = typeof hutk === 'string' && /^[a-f0-9]{32}$/i.test(hutk.trim()) ? hutk.trim() : null;

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
    fbclid:       utm?.fbclid || null,
    page_url:     pageUrlClean,
    page_title:   pageTitleClean,
    form_fields:  formFields || {},
  });

  if (error) {
    console.error('[form-leads] insert error', error);
    return NextResponse.json({ error: 'Failed to save lead' }, { status: 500 });
  }

  // Without waitUntil, Vercel can freeze this invocation the instant the response below
  // is sent — sometimes mid-fetch to HubSpot — and the dispatch never runs to completion.
  // waitUntil keeps the function alive in the background until the promise settles, without
  // delaying the response itself.
  waitUntil(dispatchIntegrationsBackground({
    testId,
    testName: test.name,
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
      fbclid:       utm?.fbclid ?? null,
      page_url:     pageUrlClean,
      page_title:   pageTitleClean,
      hutk:         hutkClean,
    },
  }));

  return NextResponse.json({ ok: true });
}

interface DispatchParams {
  testId: string;
  testName: string;
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
    fbclid?: string | null;
    page_url?: string | null;
    page_title?: string | null;
    hutk?: string | null;
  };
}

async function dispatchIntegrationsBackground(params: DispatchParams) {
  try {
    // Fetch all enabled workspace integrations for this workspace
    const { data: workspaceIntegrations } = await db
      .from('workspace_integrations')
      .select('id, type, config')
      .eq('workspace_id', params.workspaceId)
      .eq('enabled', true);

    if (!workspaceIntegrations || workspaceIntegrations.length === 0) return;

    // Fetch all enabled test-level mappings for this test in one query
    const integrationIds = workspaceIntegrations.map(i => i.id);
    const { data: mappings } = await db
      .from('test_integration_mappings')
      .select('id, workspace_integration_id, field_mappings')
      .eq('test_id', params.testId)
      .eq('enabled', true)
      .in('workspace_integration_id', integrationIds);

    if (!mappings || mappings.length === 0) return;

    // Resolve variant name once (shared across all integrations)
    let variantName: string | undefined;
    if (params.variantId) {
      const { data: variant } = await db
        .from('test_variants')
        .select('name')
        .eq('id', params.variantId)
        .single();
      variantName = variant?.name;
    }

    // Dispatch each mapping to the correct integration handler
    await Promise.allSettled(
      mappings.map(async (mapping) => {
        const integration = workspaceIntegrations.find(i => i.id === mapping.workspace_integration_id);
        if (!integration) return;

        if (integration.type === 'hubspot') {
          await handleHubSpot(params, mapping, integration, variantName);
        } else if (integration.type === 'email') {
          await handleEmail(params, mapping, variantName);
        } else if (integration.type === 'webhook') {
          await handleWebhook(params, mapping, integration, variantName);
        }
      })
    );
  } catch (err) {
    console.error('[integrations] unexpected error:', err);
  }
}

async function handleHubSpot(
  params: DispatchParams,
  mapping: { id: string; field_mappings: unknown },
  integration: { id: string; config: unknown },
  variantName: string | undefined,
) {
  const config = integration.config as { access_token: string; refresh_token: string; expires_at: string };
  if (!config.access_token) return;

  const accessToken = await getValidAccessToken({ id: integration.id, config });
  if (!accessToken) return;

  const rawMappings = mapping.field_mappings as { fieldMappings?: Record<string, string>; form_guid?: string; portal_id?: string } | Record<string, string>;
  // Support both new shape { fieldMappings, form_guid, portal_id } and legacy flat shape
  const isNewShape = rawMappings && typeof rawMappings === 'object' && 'fieldMappings' in rawMappings;
  const fieldMappings = isNewShape ? (rawMappings as { fieldMappings: Record<string, string> }).fieldMappings : rawMappings as Record<string, string>;
  const formGuid = isNewShape ? (rawMappings as { form_guid?: string }).form_guid : null;
  const portalId = isNewShape ? (rawMappings as { portal_id?: string }).portal_id : null;

  if (!fieldMappings || Object.keys(fieldMappings).length === 0) return;

  const result = await syncLeadToHubSpot({
    accessToken,
    fieldMappings,
    formFields: params.formFields,
    portalId,
    formGuid,
    systemData: { ...params.systemData, variantName },
  });

  if (result.ok) {
    console.log('[hubspot-sync] ok — testId:', params);
    await db.rpc('increment_integration_synced', { p_mapping_id: mapping.id });
  } else {
    console.error('[hubspot-sync] failed:', result.error);
    await db.rpc('increment_integration_failed', { p_mapping_id: mapping.id });
  }
}

async function handleEmail(
  params: DispatchParams,
  mapping: { id: string; field_mappings: unknown },
  variantName: string | undefined,
) {
  const emailConfig = mapping.field_mappings as EmailConfig;
  if (!emailConfig?.recipients) return;

  const result = await sendLeadNotificationEmail({
    config: emailConfig,
    testName: params.testName,
    variantName: variantName ?? 'Unknown Variant',
    formFields: params.formFields,
    systemData: {
      ip_address:   params.systemData.ip_address,
      submitted_at: params.systemData.submitted_at,
      utm_source:   params.systemData.utm_source,
      utm_medium:   params.systemData.utm_medium,
      utm_campaign: params.systemData.utm_campaign,
    },
  });

  if (result.ok) {
    await db.rpc('increment_integration_synced', { p_mapping_id: mapping.id });
  } else {
    console.error('[email-notify] failed:', result.error);
    await db.rpc('increment_integration_failed', { p_mapping_id: mapping.id });
  }
}

async function handleWebhook(
  params: DispatchParams,
  mapping: { id: string; field_mappings: unknown },
  integration: { id: string; config: unknown },
  variantName: string | undefined,
) {
  const config = integration.config as WebhookConfig;
  if (!config?.url) return;

  const fieldMappings = mapping.field_mappings as WebhookFieldMappings;
  if (!fieldMappings) return;

  const systemValues: Record<string, string | null | undefined> = {
    ip_address:   params.systemData.ip_address,
    submitted_at: params.systemData.submitted_at,
    test_id:      params.testId,
    test_name:    params.testName,
    variant_id:   params.variantId,
    variant_name: variantName,
    utm_source:   params.systemData.utm_source,
    utm_medium:   params.systemData.utm_medium,
    utm_campaign: params.systemData.utm_campaign,
    utm_content:  params.systemData.utm_content,
    utm_term:     params.systemData.utm_term,
  };

  const result = await fireWebhook({
    config,
    mappings: fieldMappings,
    formFields: params.formFields,
    systemValues,
  });

  if (result.ok) {
    await db.rpc('increment_integration_synced', { p_mapping_id: mapping.id });
  } else {
    console.error('[webhook] failed:', result.error, result.statusCode);
    await db.rpc('increment_integration_failed', { p_mapping_id: mapping.id });
  }
}
