import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } }
) {
  const { data: page } = await db
    .from('pages')
    .select('html_url, html_content')
    .eq('slug', params.slug)
    .eq('is_published', true)
    .is('deleted_at', null)
    .single();

  if (!page) {
    return new NextResponse('Page not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  let html = page.html_content as string | null;

  if (!html) {
    const res = await fetch(page.html_url);
    if (!res.ok) {
      return new NextResponse('Failed to load page', { status: 502, headers: { 'Content-Type': 'text/plain' } });
    }
    html = await res.text();
  }

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
}
