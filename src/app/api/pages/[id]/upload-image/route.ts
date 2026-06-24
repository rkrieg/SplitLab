import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { createClient } from '@supabase/supabase-js';

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'pages';

function getStorageClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const result = { ...obj };
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const existing = current[key];
    if (Array.isArray(existing)) {
      current[key] = [...existing];
    } else if (typeof existing === 'object' && existing !== null) {
      current[key] = { ...(existing as Record<string, unknown>) };
    } else {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return result;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, html_content, schema_json, slug')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fieldPath = formData.get('field_path') as string | null;

    if (!file || !fieldPath) {
      return NextResponse.json({ error: 'file and field_path are required' }, { status: 400 });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
    }

    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'Image must be under 5MB' }, { status: 400 });
    }

    // Upload image to pages/[page_id]/images/[fieldPath].[ext]
    const ext = file.name.split('.').pop() ?? 'jpg';
    const safeField = fieldPath.replace(/[^a-z0-9._-]/gi, '_');
    const imagePath = `pages/${params.id}/images/${safeField}.${ext}`;

    const storage = getStorageClient();
    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await storage.storage
      .from(BUCKET)
      .upload(imagePath, arrayBuffer, {
        contentType: file.type,
        upsert: true,
      });

    if (uploadError) throw new Error(`Image upload failed: ${uploadError.message}`);

    const { data: urlData } = storage.storage.from(BUCKET).getPublicUrl(imagePath);
    const imageUrl = urlData.publicUrl;

    // Update schema_json with the new image URL at field_path
    const updatedSchema = setNestedValue(
      (page.schema_json as Record<string, unknown>) ?? {},
      fieldPath,
      imageUrl
    );

    // Load and patch HTML — replace the src on the element with matching data-field
    let html = page.html_content;
    if (!html && page.html_url) {
      const res = await fetch(page.html_url);
      if (!res.ok) return NextResponse.json({ error: 'Could not load current HTML' }, { status: 500 });
      html = await res.text();
    }

    if (html) {
      // Replace src/href on elements with data-field="<fieldPath>"
      const escapedField = fieldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(
        new RegExp(`(<img[^>]*data-field="${escapedField}"[^>]*\\s)src="[^"]*"`, 'g'),
        `$1src="${imageUrl}"`
      );
      // Handle case where src comes before data-field
      html = html.replace(
        new RegExp(`(<img[^>]*\\s)src="[^"]*"([^>]*data-field="${escapedField}")`, 'g'),
        `$1src="${imageUrl}"$2`
      );
    }

    // Re-upload HTML
    const storagePath = page.html_url ? fileNameFromUrl(page.html_url) : '';
    let htmlUrl = page.html_url;
    if (html && storagePath) {
      htmlUrl = await uploadHtml(storagePath, html);
    }

    await db.from('pages').update({
      schema_json: updatedSchema,
      html_url: htmlUrl,
      html_content: html && html.length < 500_000 ? html : null,
      updated_at: new Date().toISOString(),
    }).eq('id', params.id);

    return NextResponse.json({ image_url: imageUrl, html_url: htmlUrl });
  } catch (err) {
    console.error('[pages/upload-image]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
