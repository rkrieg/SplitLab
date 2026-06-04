import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { fireWebhook, type WebhookConfig, type WebhookFieldMappings } from '@/lib/integrations/webhook';

export const dynamic = 'force-dynamic';

// POST /api/workspaces/[id]/integrations/test-webhook
// Body: { config: WebhookConfig; mappings: WebhookFieldMappings }
// Fires a sample payload to the given URL and returns the result.
export async function POST(
  req: NextRequest,
  { params: _params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { config?: WebhookConfig; mappings?: WebhookFieldMappings };
  const { config, mappings } = body;

  if (!config?.url) {
    return NextResponse.json({ error: 'Missing webhook URL' }, { status: 400 });
  }

  const sampleFormFields: Record<string, string> = {
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane@example.com',
    phone: '+1-555-0100',
  };

  const sampleSystemValues: Record<string, string> = {
    ip_address: '203.0.113.42',
    submitted_at: new Date().toISOString(),
    test_id: 'test-sample-id',
    test_name: 'Sample Test',
    variant_id: 'variant-sample-id',
    variant_name: 'Variant A',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'sample_campaign',
    utm_content: '',
    utm_term: '',
  };

  const effectiveMappings: WebhookFieldMappings = mappings ?? {
    formFields: Object.fromEntries(Object.keys(sampleFormFields).map(k => [k, k])),
    systemFields: Object.fromEntries(Object.keys(sampleSystemValues).map(k => [k, k])),
  };

  const result = await fireWebhook({
    config,
    mappings: effectiveMappings,
    formFields: sampleFormFields,
    systemValues: sampleSystemValues,
  });

  return NextResponse.json(result);
}
