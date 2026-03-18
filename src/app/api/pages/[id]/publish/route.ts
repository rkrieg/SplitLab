import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.user.role !== 'admin' && session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const pageId = params.id;

  const { data: page, error: fetchErr } = await db
    .from('pages')
    .select('id, status, html_url')
    .eq('id', pageId)
    .single();

  if (fetchErr || !page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  const publishedUrl = `https://pages.trysplitlab.com/${pageId}`;

  const { error: updateErr } = await db
    .from('pages')
    .update({
      status: 'active',
      published_url: publishedUrl,
    })
    .eq('id', pageId);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    published_url: publishedUrl,
    page_id: pageId,
  });
}
