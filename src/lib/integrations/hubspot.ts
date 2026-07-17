import { db } from '@/lib/supabase-server';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const HUBSPOT_FORMS_SUBMIT_BASE = 'https://api.hsforms.com';
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

export interface HubSpotFormField {
  name: string;
  label: string;
  fieldType: string;
  required: boolean;
}

export interface HubSpotForm {
  id: string;
  name: string;
  fields: HubSpotFormField[];
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
  { key: 'fbclid',        label: 'FBCLID' },
];

function authHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

// Retries fetch up to `maxAttempts` times on transient network errors (ECONNRESET, ECONNREFUSED, ETIMEDOUT).
//
// Why this exists:
//   Vercel serverless functions occasionally get a network-level connection reset when
//   making outbound HTTPS calls to api.hubapi.com (TLS handshake dropped mid-connect).
//
//   BROKEN (before): token expires → refresh fetch → ECONNRESET → returns null → sync silently skipped ❌
//   FIXED  (after):  token expires → refresh fetch → ECONNRESET → wait 500ms → retry → succeeds → sync runs ✅
async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      // Any exception thrown by fetch() is a network-level failure (not an HTTP error).
      // HTTP errors come back as a Response with !res.ok — they never throw.
      // So retry on any thrown error: ECONNRESET, SocketError (UND_ERR_SOCKET), ETIMEDOUT, etc.
      if (attempt === maxAttempts) throw err;
      lastErr = err;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

// Refresh an expired access token using the refresh token — retries on transient network errors via fetchWithRetry
async function refreshAccessToken(integrationId: string, refreshToken: string): Promise<string | null> {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetchWithRetry(HUBSPOT_TOKEN_URL, {
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

export async function fetchHubSpotForms(accessToken: string): Promise<HubSpotForm[]> {
  const forms: HubSpotForm[] = [];
  let after: string | undefined;

  do {
    const url = new URL(`${HUBSPOT_API_BASE}/marketing/v3/forms/`);
    url.searchParams.set('limit', '50');
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url.toString(), { headers: authHeaders(accessToken) });
    if (!res.ok) throw new Error(`HubSpot forms fetch failed: ${res.status}`);

    const data = await res.json() as {
      results: {
        id: string;
        name: string;
        fieldGroups?: { fields?: { name: string; label: string; fieldType: string; required?: boolean }[] }[];
      }[];
      paging?: { next?: { after: string } };
    };

    for (const form of data.results) {
      const fields: HubSpotFormField[] = [];
      for (const group of form.fieldGroups ?? []) {
        for (const f of group.fields ?? []) {
          fields.push({ name: f.name, label: f.label, fieldType: f.fieldType, required: f.required ?? false });
        }
      }
      forms.push({ id: form.id, name: form.name, fields });
    }

    after = data.paging?.next?.after;
  } while (after);

  return forms.sort((a, b) => a.name.localeCompare(b.name));
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
    fbclid?: string | null;
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
    case 'fbclid':       return systemData.fbclid ?? null;
    default:             return null;
  }
}

export async function syncLeadToHubSpot(params: {
  accessToken: string;
  fieldMappings: Record<string, string>;
  formFields: Record<string, string>;
  portalId?: string | null;
  formGuid?: string | null;
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
    fbclid?: string | null;
    page_url?: string | null;
    page_title?: string | null;
  };
}): Promise<SyncResult> {
  const { accessToken, fieldMappings, formFields, systemData, portalId, formGuid } = params;

  // Build field values from mappings
  const resolved: Record<string, string> = {};
  for (const [ourField, hubspotField] of Object.entries(fieldMappings)) {
    if (!hubspotField || hubspotField === '(-) Not mapped') continue;
    const isSystemField = SYSTEM_FIELDS.some(f => f.key === ourField);
    const value = isSystemField
      ? resolveSystemField(ourField, systemData)
      : (formFields[ourField] ?? null);
    if (value !== null && value !== '') {
      resolved[hubspotField] = value;
    }
  }

  // Form-based submission (new flow)
  if (portalId && formGuid) {
    try {
      const fields = Object.entries(resolved).map(([name, value]) => ({ name, value }));
      if (fields.length === 0) return { ok: false, error: 'No fields mapped — cannot submit HubSpot form' };
      const res = await fetchWithRetry(
        `${HUBSPOT_FORMS_SUBMIT_BASE}/submissions/v3/integration/secure/submit/${portalId}/${formGuid}`,
        {
          method: 'POST',
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            submittedAt: Date.now(),
            fields,
            // pageUri drives the "Conversion Page" column in HubSpot's submissions
            // table — without it every submission reads "Unavailable". undefined
            // (not null) so the key is dropped entirely when we have no value.
            context: {
              ipAddress: systemData.ip_address ?? undefined,
              pageUri: systemData.page_url ?? undefined,
              pageName: systemData.page_title ?? undefined,
            },
          }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string; errors?: { message: string }[] };
        const msg = body.message || body.errors?.[0]?.message || `HTTP ${res.status}`;
        return { ok: false, error: msg };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `${String(err)} | cause: ${String((err as NodeJS.ErrnoException)?.cause ?? 'none')}` };
    }
  }

  // Legacy contact upsert (fallback for mappings without form_guid)
  if (!resolved['email']) {
    return { ok: false, error: 'No email field mapped — cannot upsert HubSpot contact' };
  }

  try {
    const res = await fetchWithRetry(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/batch/upsert`,
      {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          inputs: [{ id: resolved['email'], properties: resolved, idProperty: 'email' }],
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
    return { ok: false, error: `${String(err)} | cause: ${String((err as NodeJS.ErrnoException)?.cause ?? 'none')}` };
  }
}
