import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { rawQuery } from '@/lib/db';
import { buildTestPayload, fireWebhooks } from '@/lib/webhooks';
import crypto from 'crypto';

async function ownsEndpoint(endpointId: string, workspaceId: string, userId: string): Promise<{
  id: string; url: string; secret: string; events: string[];
} | null> {
  const rows = await rawQuery<{ id: string; url: string; secret: string; events: string[] }>(
    `SELECT we.id, we.url, we.secret, we.events FROM webhook_endpoints we
     JOIN workspace_members wm ON wm.workspace_id = we.workspace_id
     WHERE we.id = $1 AND we.workspace_id = $2 AND wm.user_id = $3 LIMIT 1`,
    [endpointId, workspaceId, userId]
  );
  return rows[0] ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; endpointId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const impersonating = request.headers.get('x-sl-impersonating');
  const userId = impersonating ?? session.user.id;

  const endpoint = await ownsEndpoint(params.endpointId, params.id, userId);
  if (!endpoint) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const eventType = endpoint.events[0] ?? 'conversion';
  const payload = buildTestPayload(params.id, eventType);
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signingContent = `${timestamp}.${body}`;
  const signature = 'sha256=' + crypto.createHmac('sha256', endpoint.secret).update(signingContent).digest('hex');
  const deliveryId = crypto.randomUUID();
  const start = Date.now();

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMsg: string | null = null;

  try {
    const res = await fetch(endpoint.url, {
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
    responseBody = (await res.text()).slice(0, 500);
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const duration = Date.now() - start;

  await rawQuery(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload, response_status, response_body, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [endpoint.id, eventType, body, responseStatus, responseBody, errorMsg, duration]
  );

  return NextResponse.json({
    ok: !errorMsg && responseStatus && responseStatus < 400,
    response_status: responseStatus,
    response_body: responseBody,
    error: errorMsg,
    duration_ms: duration,
  });
}
