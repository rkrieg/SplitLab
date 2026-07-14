import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml, uploadImage, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';

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

  if (session.user.role !== 'admin') {
    const ownerPlan = await resolveOwnerPlan(page.workspace_id);
    if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
      return NextResponse.json(
        { error: 'AI page editing requires an Agency or Scale plan. Please upgrade to use this feature.', limitError: true },
        { status: 403 }
      );
    }
  }

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

    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'Image must be under 5MB' }, { status: 400 });
    }

    const ext = file.name.split('.').pop() ?? 'jpg';
    const arrayBuffer = await file.arrayBuffer();

    // Upload image to public ai-pages-images bucket
    const imageUrl = await uploadImage(params.id, arrayBuffer, file.type, ext);

    // Update schema_json with the new image URL at field_path
    const updatedSchema = setNestedValue(
      (page.schema_json as Record<string, unknown>) ?? {},
      fieldPath,
      imageUrl
    );

    // Load current HTML via service role (private bucket)
    let html: string | null = page.html_content;
    if (!html && page.html_url) {
      html = await downloadHtmlByPath(fileNameFromUrl(page.html_url));
    }

    if (html) {
      const escapedField = fieldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(
        new RegExp(`(<img[^>]*data-field="${escapedField}"[^>]*\\s)src="[^"]*"`, 'g'),
        `$1src="${imageUrl}"`
      );
      html = html.replace(
        new RegExp(`(<img[^>]*\\s)src="[^"]*"([^>]*data-field="${escapedField}")`, 'g'),
        `$1src="${imageUrl}"$2`
      );
    }

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
