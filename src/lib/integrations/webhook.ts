export interface WebhookConfig {
  url: string;
  format: 'json' | 'form' | 'xml';
  headers: { key: string; value: string }[];
}

export interface WebhookFieldMappings {
  formFields: Record<string, string>;
  systemFields: Record<string, string>;
}

export interface WebhookFireResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

const SYSTEM_FIELD_KEYS = [
  'ip_address',
  'submitted_at',
  'test_id',
  'test_name',
  'variant_id',
  'variant_name',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  // Were missing here while hubspot.ts SYSTEM_FIELDS has had them all along —
  // webhook users simply could not map the click IDs.
  'gclid',
  'fbclid',
] as const;

export { SYSTEM_FIELD_KEYS };

function buildPayload(
  formFields: Record<string, string>,
  systemValues: Record<string, string | null | undefined>,
  mappings: WebhookFieldMappings,
): Record<string, string> {
  const payload: Record<string, string> = {};

  // Apply form field mappings
  for (const [slField, webhookKey] of Object.entries(mappings.formFields)) {
    const key = webhookKey?.trim();
    if (!key) continue; // blank right side = exclude
    const value = formFields[slField];
    if (value !== undefined && value !== null) {
      payload[key] = String(value);
    }
  }

  // Apply system field mappings
  for (const [slField, webhookKey] of Object.entries(mappings.systemFields)) {
    const key = webhookKey?.trim();
    if (!key) continue; // blank right side = exclude
    const value = systemValues[slField];
    if (value !== undefined && value !== null) {
      payload[key] = String(value);
    }
  }

  return payload;
}

function toXml(payload: Record<string, string>): string {
  const fields = Object.entries(payload)
    .map(([k, v]) => `  <${k}>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</${k}>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<lead>\n${fields}\n</lead>`;
}

function toFormEncoded(payload: Record<string, string>): string {
  return Object.entries(payload)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export async function fireWebhook(params: {
  config: WebhookConfig;
  mappings: WebhookFieldMappings;
  formFields: Record<string, string>;
  systemValues: Record<string, string | null | undefined>;
}): Promise<WebhookFireResult> {
  const { config, mappings, formFields, systemValues } = params;

  if (!config.url) return { ok: false, error: 'No URL configured' };

  const payload = buildPayload(formFields, systemValues, mappings);

  const headers: Record<string, string> = {};
  for (const h of config.headers ?? []) {
    if (h.key?.trim()) headers[h.key.trim()] = h.value ?? '';
  }

  let body: string;
  if (config.format === 'xml') {
    headers['Content-Type'] = 'application/xml';
    body = toXml(payload);
  } else if (config.format === 'form') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = toFormEncoded(payload);
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { ok: res.ok, statusCode: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
