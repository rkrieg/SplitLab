import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, html_content, slug, status')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    // Load current HTML — bucket is private, use service role client
    let html = page.html_content;
    if (!html) {
      const filePath = fileNameFromUrl(page.html_url);
      html = await downloadHtmlByPath(filePath);
    }

    // Inject tracker.js
    const trackerScript = `<script src="${APP_URL}/tracker.js"></script>`;
    html = html.replace('<!-- TRACKER_PLACEHOLDER -->', trackerScript);

    // Generate slug if not set
    const slug = page.slug ?? crypto.randomUUID();

    // Re-upload to same storage path
    const storagePath = fileNameFromUrl(page.html_url);
    const htmlUrl = await uploadHtml(storagePath, html);

    const publishedUrl = `${APP_URL}/pages/${slug}`;

    await db.from('pages').update({
      is_published: true,
      slug,
      html_url: htmlUrl,
      html_content: html.length < 500_000 ? html : null,
      published_url: publishedUrl,
      updated_at: new Date().toISOString(),
    }).eq('id', params.id);

    return NextResponse.json({ published_url: publishedUrl, slug });
  } catch (err) {
    console.error('[pages/publish]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
