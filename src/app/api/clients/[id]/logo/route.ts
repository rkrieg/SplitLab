import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadFavicon, deleteFaviconByUrl } from '@/lib/storage';

const MAX_SIZE = 1024 * 1024; // 1MB
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

async function canManageClient(clientId: string, userId: string, userRole: string) {
  if (userRole === 'viewer') return false;
  if (userRole === 'admin') return true;

  const { data: client } = await db
    .from('clients')
    .select('owner_id')
    .eq('id', clientId)
    .single();

  if (client?.owner_id === userId) return true;

  const { data: workspaces } = await db
    .from('workspaces')
    .select('id')
    .eq('client_id', clientId);

  const workspaceIds = workspaces?.map(w => w.id) ?? [];
  if (workspaceIds.length === 0) return false;

  const { data: member } = await db
    .from('workspace_members')
    .select('id')
    .eq('user_id', userId)
    .in('workspace_id', workspaceIds)
    .limit(1)
    .single();

  return !!member;
}

async function removeOldLogo(clientId: string) {
  const { data: client } = await db
    .from('clients')
    .select('logo_url')
    .eq('id', clientId)
    .single();

  if (client?.logo_url) {
    try { await deleteFaviconByUrl(client.logo_url); } catch { /* orphan cleanup is best-effort */ }
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!await canManageClient(params.id, session.user.id, session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    // Blob (not File): the File global doesn't exist before Node 20
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const ext = ALLOWED_TYPES[file.type];
    if (!ext) {
      return NextResponse.json({ error: 'Invalid file type. Allowed: PNG, JPG, ICO' }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large. Max 1MB' }, { status: 400 });
    }

    const { data: existing } = await db
      .from('clients')
      .select('logo_url')
      .eq('id', params.id)
      .single();

    const buffer = await file.arrayBuffer();
    const fileName = `${params.id}.${ext}`;
    const publicUrl = await uploadFavicon(fileName, buffer, file.type);
    const logoUrl = `${publicUrl}?v=${Date.now()}`;

    const { data: updated, error } = await db
      .from('clients')
      .update({ logo_url: logoUrl })
      .eq('id', params.id)
      .select('id, logo_url')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Only after the new logo is live: clean up the old file if the extension
    // changed (same extension means the upsert already overwrote it)
    if (existing?.logo_url && !existing.logo_url.split('?')[0].endsWith(`/${fileName}`)) {
      try { await deleteFaviconByUrl(existing.logo_url); } catch { /* orphan cleanup is best-effort */ }
    }

    return NextResponse.json(updated);
  } catch (err) {
    console.error('[logo upload]', err);
    const message = err instanceof Error ? err.message : 'Upload failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!await canManageClient(params.id, session.user.id, session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await removeOldLogo(params.id);

  const { error } = await db
    .from('clients')
    .update({ logo_url: null })
    .eq('id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
