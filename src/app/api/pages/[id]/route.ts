import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { deleteHtmlFile, deletePageImages, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { updatePageDraftOrLive, getPageWithContent } from '@/lib/services/pages';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  prompt: z.string().optional(),
  html_content: z.string().optional(),
  html_url: z.string().url().optional(),
  slug: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['active', 'archived']).optional(),
  schema_json: z.record(z.unknown()).optional(),
  conversation_json: z.array(z.unknown()).optional(),
  // Explicit opt-in, set only by the WYSIWYG click-to-edit autosave in
  // AIBuilderClient — writes land in draft_* columns instead of live ones
  // when the page is actually a test variant. The "Edit HTML" CodeMirror
  // modal in AnalyticsClient never sends this and always writes live, by
  // design — whatever it does gets superseded if the user later replaces
  // the variant with their draft anyway.
  draft: z.boolean().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await getPageWithContent(params.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const data = result.data as { workspace_id: string };

  const wsRole = await resolveWorkspaceRole(data.workspace_id, session.user.id, session.user.role);
  if (!wsRole) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return NextResponse.json(data);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: pageMeta } = await db.from('pages').select('workspace_id, html_url, schema_json').eq('id', params.id).single();
  if (!pageMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const wsRole = await resolveWorkspaceRole(pageMeta.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const body = await request.json();
    const input = updateSchema.parse(body);

    const result = await updatePageDraftOrLive(params.id, { html_url: pageMeta.html_url, schema_json: pageMeta.schema_json }, input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (page?.html_url) {
    const fileName = fileNameFromUrl(page.html_url);
    if (fileName) {
      try { await deleteHtmlFile(fileName); } catch { /* ignore */ }
    }
  }

  const { error } = await db.from('pages').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try { await deletePageImages(params.id); } catch { /* ignore — bucket may be empty */ }

  return NextResponse.json({ ok: true });
}
