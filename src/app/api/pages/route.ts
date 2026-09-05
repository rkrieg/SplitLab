import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { createPage } from '@/lib/services/pages';

// Taking in HTML now also copies its images into our storage (see
// takeOwnershipOfHtmlAssets), which is network work proportional to how many
// images the page has. On the platform default (~10-15s) an image-heavy page
// would be killed mid-copy, leaving it half-owned. Well under the 800s the AI
// routes use — this is downloads, not generation.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    // Inside the try on purpose. Left outside, anything this throws (a cookie
    // it can't decrypt, a secret mismatch) escapes the handler entirely and
    // the platform answers with an HTML error page instead of our JSON — the
    // client then chokes on "<" and shows a parser error as the toast.
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const {
      workspace_id, name, vertical,
      prompt, schema_json, conversation_json,
      html_url, html_content, slug,
    } = await request.json();

    if (!workspace_id || !name || !vertical) {
      return NextResponse.json(
        { error: 'workspace_id, name, and vertical are required' },
        { status: 400 }
      );
    }

    const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const result = await createPage({
      workspace_id, name, vertical, prompt, schema_json, conversation_json,
      html_url, html_content, slug, created_by: session.user.id,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data, { status: 201 });
  } catch (err) {
    console.error('[POST /api/pages]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
