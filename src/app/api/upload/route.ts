import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml } from '@/lib/storage';
import { z } from 'zod';

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

const metaSchema = z.object({
  name: z.string().min(1).max(255),
  workspace_id: z.string().uuid(),
  tags: z.array(z.string()).optional(),
});

/**
 * POST /api/upload
 * Accepts multipart/form-data with:
 *   - file: HTML file (optional)
 *   - html: raw HTML string (optional)
 *   - name: page name
 *   - workspace_id: workspace UUID
 *   - tags: comma-separated tags (optional)
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const formData = await request.formData();

    const name = formData.get('name') as string;
    const workspaceId = formData.get('workspace_id') as string;
    const tagsRaw = formData.get('tags') as string | null;
    const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];

    metaSchema.parse({ name, workspace_id: workspaceId, tags });

    let htmlContent = '';

    const file = formData.get('file') as File | null;
    const rawHtml = formData.get('html') as string | null;

    if (file) {
      if (file.size > MAX_SIZE) {
        return NextResponse.json({ error: 'File too large (max 5 MB)' }, { status: 413 });
      }
      htmlContent = await file.text();
    } else if (rawHtml) {
      htmlContent = rawHtml;
    } else {
      return NextResponse.json({ error: 'No HTML provided' }, { status: 400 });
    }

    if (!htmlContent.trim()) {
      return NextResponse.json({ error: 'HTML content is empty' }, { status: 400 });
    }

    // Upload to storage
    const fileName = `${workspaceId}/${crypto.randomUUID()}.html`;
    const htmlUrl = await uploadHtml(fileName, htmlContent);

    // Save to DB
    const { data: page, error } = await db
      .from('pages')
      .insert({
        workspace_id: workspaceId,
        name,
        html_url: htmlUrl,
        html_content: htmlContent,
        tags,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(page, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error('[upload]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
