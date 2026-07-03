import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';

// GET /api/tests/[id]/form-field-keys
// Returns distinct form field names for all variants of this test.
// Priority:
//   1. variant_form_fields (populated by tracker.js on page load) — most accurate
//   2. form_leads.form_fields keys (fallback from submitted leads)
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Get all variant IDs for this test
  const { data: variants } = await db
    .from('test_variants')
    .select('id')
    .eq('test_id', params.id);

  const variantIds = (variants ?? []).map(v => v.id);
  const keys = new Set<string>();

  // Priority 1: variant_form_fields (registered by tracker.js)
  if (variantIds.length > 0) {
    const { data: formFields } = await db
      .from('variant_form_fields')
      .select('fields')
      .in('variant_id', variantIds);

    for (const row of formFields ?? []) {
      for (const field of row.fields ?? []) {
        keys.add(field);
      }
    }
  }

  // Priority 2: fallback to form_leads if tracker.js hasn't run yet
  if (keys.size === 0) {
    const { data, error } = await db.rpc('get_distinct_form_field_keys', {
      p_test_id: params.id,
    });

    if (!error && data) {
      for (const row of (data as { key: string }[])) {
        keys.add(row.key);
      }
    } else {
      // Final fallback: JS-side extraction
      const { data: leads } = await db
        .from('form_leads')
        .select('form_fields')
        .eq('test_id', params.id)
        .limit(100);

      for (const lead of leads ?? []) {
        for (const key of Object.keys(lead.form_fields ?? {})) {
          keys.add(key);
        }
      }
    }
  }

  return NextResponse.json({ keys: Array.from(keys).sort() });
}
