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
    return new NextResponse(notFoundHtml(), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  let html = page.html_content as string | null;

  if (!html) {
    const res = await fetch(page.html_url);
    if (!res.ok) {
      return new NextResponse(notFoundHtml(), { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    html = await res.text();
  }

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

function notFoundHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Not Found</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center}.code{font-size:4rem;font-weight:700;color:#3D8BDA}h1{margin:.5rem 0}p{color:#94a3b8}</style>
</head>
<body><div class="box"><div class="code">404</div><h1>Page Not Found</h1>
<p>This page doesn't exist or has been unpublished.</p></div></body>
</html>`;
}
