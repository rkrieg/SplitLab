import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { forkPageAsNewVariant } from '@/lib/services/pages';
import { z } from 'zod';

const saveAsNewSchema = z.object({
  name: z.string().trim().min(1, 'Variant name is required').max(255),
});

// Forks a variant page's draft into a brand-new page and immediately wires
// it into the same test as a new variant at 0% traffic — the live variant
// and every other variant's traffic split are left completely untouched.
// The user ramps its traffic up manually once they're happy with it.
// Extracted into forkPageAsNewVariant() (src/lib/services/pages.ts) so this
// route and MCP's save_page_as_new tool share one implementation.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // no body sent — falls through to the schema check below, which
    // rejects it since name is required
  }
  const parsed = saveAsNewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, vertical, html_content, schema_json, draft_html_content, draft_schema_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const result = await forkPageAsNewVariant(params.id, page, parsed.data.name, session.user.role);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...(result.limitError ? { limitError: true } : {}) }, { status: result.status });
  }

  return NextResponse.json(result.data);
}
