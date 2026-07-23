import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml, deleteHtmlFile, deletePageImages, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
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
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await db
    .from('pages')
    .select('*')
    .eq('id', params.id)
    .single();

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

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
    const data = updateSchema.parse(body);

    // If html_content is being updated, re-upload to storage
    let storageUrl: string | undefined;
    if (data.html_content) {
      const existing = pageMeta;

      if (existing?.html_url) {
        const fileName = fileNameFromUrl(existing.html_url);
        if (fileName) {
          storageUrl = await uploadHtml(fileName, data.html_content);
        }
      }
    }

    // html_content = manual edit; html_url = AI rebuild that uploaded fresh HTML to storage.
    // Either way the markup is replaced, so old selectors can't be trusted.
    const htmlReplaced = Boolean(data.html_content || data.html_url);

    // If HTML is being replaced by a caller that did NOT also send a matching
    // schema_json (e.g. a manual raw-HTML edit), any existing schema is now
    // out of sync with the actual markup — a later AI structural edit would
    // silently rebuild from the stale schema and discard the manual change.
    const schemaNowStale = htmlReplaced && data.schema_json === undefined && !!pageMeta?.schema_json;

    const updatePayload = {
      ...data,
      ...(storageUrl ? { html_url: storageUrl } : {}),
      // HTML changed → old injected #sl-f-xxx IDs are gone; clear mappings and rules
      ...(htmlReplaced ? { field_selectors_json: null } : {}),
      // A rebuild replaces the storage file only — stale html_content from an earlier
      // inline edit would shadow the new HTML in preview/serve, so drop it
      ...(data.html_url && !data.html_content ? { html_content: null } : {}),
      ...(schemaNowStale ? { schema_json: null, conversation_json: [] } : {}),
    };

    // If HTML is being replaced, wipe personalization rules (selectors no longer valid)
    if (htmlReplaced) {
      await db.from('personalization_rules').delete().eq('page_id', params.id);
    }

    const { data: updated, error } = await db
      .from('pages')
      .update(updatePayload)
      .eq('id', params.id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(updated);
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
