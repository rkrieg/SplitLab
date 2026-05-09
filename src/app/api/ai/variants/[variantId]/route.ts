import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

const VARIANTS_BUCKET = 'variants';

export async function PUT(
  request: NextRequest,
  { params }: { params: { variantId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['admin', 'manager', 'super_admin'].includes(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { variantId } = params;

  let html: string;
  try {
    const body = await request.json();
    html = body.html;
    if (!html || typeof html !== 'string') throw new Error();
  } catch {
    return NextResponse.json({ error: 'Missing required field: html' }, { status: 400 });
  }

  // Fetch variant_pages record
  const { data: variantPage, error: vpErr } = await (db
    .from('variant_pages')
    .select('*')
    .eq('variant_id', variantId)
    .order('version', { ascending: false })
    .limit(1)
    .single() as unknown as Promise<{ data: { id: string; html_storage_path: string; version: number } | null; error: { message: string } | null }>);

  if (vpErr || !variantPage) {
    return NextResponse.json({ error: 'Variant page not found' }, { status: 404 });
  }

  // Upload updated HTML to storage (overwrite)
  const { error: uploadErr } = await (db.storage
    .from(VARIANTS_BUCKET)
    .upload(variantPage.html_storage_path, html, {
      contentType: 'text/html; charset=utf-8',
      upsert: true,
    }) as unknown as Promise<{ error: { message: string } | null }>);

  if (uploadErr) {
    return NextResponse.json({ error: `Upload failed: ${uploadErr.message}` }, { status: 500 });
  }

  // Increment version
  const { error: updateErr } = await (db
    .from('variant_pages')
    .update({
      version: variantPage.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', variantPage.id) as unknown as Promise<{ error: { message: string } | null }>);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    version: variantPage.version + 1,
  });
}
