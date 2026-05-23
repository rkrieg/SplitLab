import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const elementSchema = z.object({
  type: z.enum(['form', 'button', 'call', 'cta_link']),
  id: z.string().max(255).nullable(),
  text: z.string().max(200).nullable(),
});

const schema = z.object({
  vid: z.string().uuid(),
  elements: z.array(elementSchema).max(200),
});

export async function POST(request: NextRequest) {
  const headers = corsHeaders(request);
  try {
    const body = await request.json();
    const { vid, elements } = schema.parse(body);

    // Resolve variant → test + variant name
    const { data: variant } = await db
      .from('test_variants')
      .select('test_id, name')
      .eq('id', vid)
      .single();

    if (!variant) {
      return NextResponse.json({ error: 'Variant not found' }, { status: 404, headers });
    }

    // Read existing scan_results to merge (keep other variants' results)
    const { data: test } = await db
      .from('tests')
      .select('scan_results')
      .eq('id', variant.test_id)
      .single();

    const existing = test?.scan_results as { variants?: VariantScan[] } | null;
    const variantScans: VariantScan[] = existing?.variants ?? [];

    const newEntry: VariantScan = {
      variant_id: vid,
      variant_name: variant.name,
      scanned_at: new Date().toISOString(),
      elements,
    };

    // Replace entry for this variant (or append if first time)
    const idx = variantScans.findIndex(v => v.variant_id === vid);
    if (idx >= 0) {
      variantScans[idx] = newEntry;
    } else {
      variantScans.push(newEntry);
    }

    const { error } = await db
      .from('tests')
      .update({ scan_results: { variants: variantScans } })
      .eq('id', variant.test_id);

    if (error) throw error;

    return NextResponse.json({ ok: true }, { headers });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400, headers });
    }
    console.error('[scan]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers });
  }
}

interface VariantScan {
  variant_id: string;
  variant_name: string;
  scanned_at: string;
  elements: { type: string; id: string | null; text: string | null }[];
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: corsHeaders(request) });
}
