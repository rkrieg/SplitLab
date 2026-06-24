import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return new NextResponse('Unauthorized', { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, html_content')
    .eq('id', params.id)
    .single();

  if (!page) return new NextResponse('Not found', { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole) return new NextResponse('Forbidden', { status: 403 });

  try {
    let html = page.html_content as string | null;

    if (!html) {
      const filePath = fileNameFromUrl(page.html_url);
      html = await downloadHtmlByPath(filePath);
    }

    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch {
    return new NextResponse('Failed to load preview', { status: 502 });
  }
}
