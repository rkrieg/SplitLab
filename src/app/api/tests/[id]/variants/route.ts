import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { createVariant } from '@/lib/services/tests';
import { notifyVariantLive } from '@/lib/email/activity';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';

// Taking in HTML now also copies its images into our storage (see
// takeOwnershipOfHtmlAssets), which is network work proportional to how many
// images the page has. On the platform default (~10-15s) an image-heavy page
// would be killed mid-copy, leaving it half-owned. Well under the 800s the AI
// routes use — this is downloads, not generation.
export const maxDuration = 300;

const addVariantSchema = z.object({
  name: z.string().min(1),
  redirect_url: z.string().url().nullable().optional(),
  html_content: z.string().optional(),
  proxy_mode: z.boolean().optional(),
  // Accepted and ignored. New variants always join at 0% (see
  // lib/traffic-weights) — kept in the schema only so an older client still
  // sending it gets its variant instead of a 400.
  traffic_weight: z.number().int().min(0).max(100).optional(),
});

// Extracted into createVariant() (src/lib/services/tests.ts) so this route
// and MCP's create_variant tool share one implementation.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const data = addVariantSchema.parse(body);

    // Fetch test first — needed for both auth and workspace context
    const { data: test, error: testErr } = await db
      .from('tests')
      .select('id, workspace_id, status, name')
      .eq('id', params.id)
      .single();
    if (testErr || !test) {
      return NextResponse.json({ error: 'Test not found' }, { status: 404 });
    }

    const wsRole = await resolveWorkspaceRole(test.workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { traffic_weight: _ignoredWeight, ...variantInput } = data;
    const result = await createVariant(params.id, test.workspace_id, session.user.role, variantInput);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, ...(result.limitError ? { limitError: true } : {}) }, { status: result.status });
    }

    // "New variant live" — only when the test is already serving traffic.
    if (test.status === 'active') {
      waitUntil(notifyVariantLive({
        workspaceId: test.workspace_id,
        testId: params.id,
        testName: (test as { name?: string }).name ?? 'your test',
        variantName: data.name,
      }));
    }

    return NextResponse.json(result.data, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
