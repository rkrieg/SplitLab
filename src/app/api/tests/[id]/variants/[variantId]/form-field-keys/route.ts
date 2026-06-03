import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// GET /api/tests/[id]/variants/[variantId]/form-field-keys
// Returns distinct form field keys from real submitted leads for this variant
// Used to populate the left column of the field mapping UI
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; variantId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Use Postgres jsonb_object_keys to extract distinct field names from form_fields JSONB
  const { data, error } = await db.rpc('get_distinct_form_field_keys', {
    p_variant_id: params.variantId,
  });

  if (error) {
    // Fallback: fetch a sample of leads and extract keys in JS
    const { data: leads, error: leadsError } = await db
      .from('form_leads')
      .select('form_fields')
      .eq('variant_id', params.variantId)
      .limit(50);

    if (leadsError) return NextResponse.json({ error: leadsError.message }, { status: 500 });

    const keys = new Set<string>();
    for (const lead of leads ?? []) {
      for (const key of Object.keys(lead.form_fields ?? {})) {
        keys.add(key);
      }
    }
    return NextResponse.json({ keys: Array.from(keys).sort() });
  }

  const keys = (data as { key: string }[] ?? []).map(r => r.key).sort();
  return NextResponse.json({ keys });
}
