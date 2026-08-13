import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';
import { duplicateVariant } from '@/lib/services/tests';

type Params = { params: { id: string; variantId: string } };

// POST /api/tests/[id]/variants/[variantId]/duplicate
// Clones a variant (HTML, Redirect, or Proxy mode) into a new variant on the
// same test. See duplicateVariant() in @/lib/services/tests for the full
// guard/behavior notes (0% starting traffic, page-can-only-back-one-variant,
// goals/personalization intentionally not copied) — shared with the MCP
// duplicate_variant tool so both call the exact same guarded logic.
export async function POST(_req: NextRequest, { params }: Params) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const result = await duplicateVariant(params.id, params.variantId, access.workspaceId, session.user.role);
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.limitError ? { limitError: true } : {}) }, { status: result.status });
  return NextResponse.json(result.data, { status: 201 });
}
