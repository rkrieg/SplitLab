import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: corsHeaders(request) });
}

// POST /api/register-form-fields
// Called by tracker.js on page load — registers all input[name] fields for a variant
// Body: { variantId: string, fields: string[] }
export async function POST(request: NextRequest) {
  const headers = corsHeaders(request);
  try {
    const body = await request.json() as { variantId?: string; fields?: string[] };
    const { variantId, fields } = body;

    if (!variantId || !Array.isArray(fields) || fields.length === 0) {
      return NextResponse.json({ ok: true }, { headers }); // silently ignore invalid
    }

    // Sanitize — only keep non-empty strings, max 100 chars, max 50 fields
    const clean = fields
      .filter(f => typeof f === 'string' && f.trim().length > 0)
      .map(f => f.trim().slice(0, 100))
      .slice(0, 50);

    if (clean.length === 0) return NextResponse.json({ ok: true }, { headers });

    // Upsert — update fields list if variant already exists
    await db
      .from('variant_form_fields')
      .upsert({ variant_id: variantId, fields: clean, updated_at: new Date().toISOString() }, { onConflict: 'variant_id' });

    return NextResponse.json({ ok: true }, { headers });
  } catch (err) {
    console.error('[register-form-fields]', err);
    return NextResponse.json({ ok: true }, { headers }); // never error — don't break page
  }
}
