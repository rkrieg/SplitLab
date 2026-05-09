import crypto from 'crypto';
import { rawQuery } from '@/lib/db';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  workspace_id: string;
  [key: string]: unknown;
}

function signPayload(secret: string, body: string, timestamp: number): string {
  const signingContent = `${timestamp}.${body}`;
  return 'sha256=' + crypto.createHmac('sha256', secret).update(signingContent).digest('hex');
}

async function deliverWebhook(
  endpointId: string,
  url: string,
  secret: string,
  eventType: string,
  payload: WebhookPayload
): Promise<void> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(secret, body, timestamp);
  const deliveryId = crypto.randomUUID();
  const start = Date.now();

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMsg: string | null = null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SplitLab-Webhooks/1.0',
        'X-SplitLab-Event': eventType,
        'X-SplitLab-Delivery': deliveryId,
        'X-SplitLab-Timestamp': String(timestamp),
        'X-SplitLab-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    responseStatus = res.status;
    responseBody = (await res.text()).slice(0, 1000);
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const duration = Date.now() - start;

  // Log delivery (non-blocking)
  rawQuery(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload, response_status, response_body, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [endpointId, eventType, JSON.stringify(payload), responseStatus, responseBody, errorMsg, duration]
  ).catch(() => {});
}

// Fire all active webhooks for a workspace that subscribe to a given event type.
// Non-blocking — call without awaiting.
export async function fireWebhooks(
  workspaceId: string,
  eventType: string,
  payload: Omit<WebhookPayload, 'event' | 'timestamp' | 'workspace_id'>
): Promise<void> {
  try {
    const endpoints = await rawQuery<{
      id: string;
      url: string;
      secret: string;
    }>(
      `SELECT id, url, secret FROM webhook_endpoints
       WHERE workspace_id = $1 AND is_active = true AND $2 = ANY(events)`,
      [workspaceId, eventType]
    );

    if (!endpoints.length) return;

    const fullPayload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      workspace_id: workspaceId,
      ...payload,
    };

    await Promise.allSettled(
      endpoints.map((ep) => deliverWebhook(ep.id, ep.url, ep.secret, eventType, fullPayload))
    );
  } catch (err) {
    console.error('[webhooks] fire error:', err);
  }
}

// Build a test payload for a given event type
export function buildTestPayload(workspaceId: string, eventType: string): WebhookPayload {
  return {
    event: eventType,
    timestamp: new Date().toISOString(),
    workspace_id: workspaceId,
    test: true,
    test_id: '00000000-0000-0000-0000-000000000001',
    test_name: 'Example A/B Test',
    test_url: '/landing',
    variant_id: '00000000-0000-0000-0000-000000000002',
    variant_name: 'Variant B',
    goal_id: '00000000-0000-0000-0000-000000000003',
    goal_name: 'Form Submitted',
    goal_type: 'form_submit',
    is_primary_goal: true,
    visitor_hash: 'abc123def456',
    metadata: {},
  };
}
