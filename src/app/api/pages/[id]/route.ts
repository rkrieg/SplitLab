import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml, deleteHtmlFile, fileNameFromUrl } from '@/lib/storage';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  html_content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['active', 'archived']).optional(),
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

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const data = updateSchema.parse(body);

    // If html_content is being updated, re-upload to storage
    let storageUrl: string | undefined;
    if (data.html_content) {
      const { data: existing } = await db
        .from('pages')
        .select('html_url')
        .eq('id', params.id)
        .single();

      if (existing?.html_url) {
        const fileName = fileNameFromUrl(existing.html_url);
        if (fileName) {
          storageUrl = await uploadHtml(fileName, data.html_content);
        }
      }
    }

    const updatePayload = {
      ...data,
      ...(storageUrl ? { html_url: storageUrl } : {}),
    };

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
  if (session.user.role === 'viewer') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Get page to clean up storage
  const { data: page } = await db
    .from('pages')
    .select('html_url')
    .eq('id', params.id)
    .single();

  if (page?.html_url) {
    const fileName = fileNameFromUrl(page.html_url);
    if (fileName) {
      try { await deleteHtmlFile(fileName); } catch { /* ignore */ }
    }
  }

  const { error } = await db.from('pages').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
