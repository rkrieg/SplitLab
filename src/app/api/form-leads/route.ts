import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

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

  // Verify test exists
  const { data: test } = await db.from('tests').select('id').eq('id', testId).single();
  if (!test) {
    return NextResponse.json({ error: 'Test not found' }, { status: 404 });
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null;

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

  return NextResponse.json({ ok: true });
}
