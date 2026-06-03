import { db } from '@/lib/supabase-server';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

export interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
}

export interface SyncResult {
  ok: boolean;
  contactId?: string;
  error?: string;
}

// System fields we always expose for mapping (from form_leads columns)
export const SYSTEM_FIELDS = [
  { key: 'ip_address',    label: 'IP Address' },
  { key: 'variant',       label: 'Page Variant' },
  { key: 'submitted_at',  label: 'Submission Date' },
  { key: 'utm_source',    label: 'UTM Source' },
  { key: 'utm_medium',    label: 'UTM Medium' },
  { key: 'utm_campaign',  label: 'UTM Campaign' },
  { key: 'utm_content',   label: 'UTM Content' },
  { key: 'utm_term',      label: 'UTM Term' },
  { key: 'gclid',         label: 'GCLID' },
];

function authHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

// Refresh an expired access token using the refresh token
async function refreshAccessToken(integrationId: string, refreshToken: string): Promise<string | null> {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      console.error('[hubspot] token refresh failed:', res.status);
      return null;
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    // Persist new tokens — use RPC to merge only token fields inside config JSONB
    await db.rpc('update_integration_tokens', {
      p_integration_id: integrationId,
      p_access_token: data.access_token,
      p_refresh_token: data.refresh_token,
      p_expires_at: expiresAt,
    });

    return data.access_token;
  } catch (err) {
    console.error('[hubspot] token refresh error:', err);
    return null;
  }
}

// Returns a valid access token — refreshes automatically if expired
export async function getValidAccessToken(integration: {
  id: string;
  config: {
    access_token: string;
    refresh_token: string;
    expires_at: string;
  };
}): Promise<string | null> {
  const { access_token, refresh_token, expires_at } = integration.config;

  // Give 60s buffer before actual expiry to avoid edge cases
  const isExpired = new Date(expires_at).getTime() - 60_000 < Date.now();

  if (!isExpired) return access_token;

  return refreshAccessToken(integration.id, refresh_token);
}

export async function fetchHubSpotProperties(accessToken: string): Promise<HubSpotProperty[]> {
  const res = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/properties/contacts?archived=false`,
    { headers: authHeaders(accessToken) }
  );
  if (!res.ok) throw new Error(`HubSpot properties fetch failed: ${res.status}`);

  const data = await res.json() as {
    results: (HubSpotProperty & {
      hidden?: boolean;
      modificationMetadata?: { readOnlyValue?: boolean };
    })[]
  };

  return data.results
    .filter(p =>
      // Remove hidden properties
      !p.hidden &&
      // Remove read-only system properties
      !p.modificationMetadata?.readOnlyValue &&
      // Remove internal HubSpot system fields (hs_ prefix)
      !p.name.startsWith('hs_') &&
      // Remove calculated/formula fields
      p.fieldType !== 'calculation_read_only'
    )
    .sort((a, b) => a.label.localeCompare(b.label));
}

function resolveSystemField(
  key: string,
  systemData: {
    ip_address?: string | null;
    variantName?: string;
    submitted_at?: string;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
    gclid?: string | null;
  }
): string | null {
  switch (key) {
    case 'ip_address':   return systemData.ip_address ?? null;
    case 'variant':      return systemData.variantName ?? null;
    case 'submitted_at': return systemData.submitted_at ?? null;
    case 'utm_source':   return systemData.utm_source ?? null;
    case 'utm_medium':   return systemData.utm_medium ?? null;
    case 'utm_campaign': return systemData.utm_campaign ?? null;
    case 'utm_content':  return systemData.utm_content ?? null;
    case 'utm_term':     return systemData.utm_term ?? null;
    case 'gclid':        return systemData.gclid ?? null;
    default:             return null;
  }
}

export async function syncLeadToHubSpot(params: {
  accessToken: string;
  fieldMappings: Record<string, string>;
  formFields: Record<string, string>;
  systemData: {
    ip_address?: string | null;
    variantName?: string;
    submitted_at?: string;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
    gclid?: string | null;
  };
}): Promise<SyncResult> {
  const { accessToken, fieldMappings, formFields, systemData } = params;

  const properties: Record<string, string> = {};

  for (const [ourField, hubspotProp] of Object.entries(fieldMappings)) {
    if (!hubspotProp || hubspotProp === '(-) Not mapped') continue;

    const isSystemField = SYSTEM_FIELDS.some(f => f.key === ourField);
    const value = isSystemField
      ? resolveSystemField(ourField, systemData)
      : (formFields[ourField] ?? null);

    if (value !== null && value !== '') {
      properties[hubspotProp] = value;
    }
  }

  if (!properties['email']) {
    return { ok: false, error: 'No email field mapped — cannot upsert HubSpot contact' };
  }

  try {
    const res = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/batch/upsert`,
      {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          inputs: [{ id: properties['email'], properties, idProperty: 'email' }],
        }),
      }
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string };
      return { ok: false, error: body.message || `HTTP ${res.status}` };
    }

    const data = await res.json() as { results?: { id: string }[] };
    return { ok: true, contactId: data.results?.[0]?.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
