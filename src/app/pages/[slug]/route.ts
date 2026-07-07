import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { buildUtmSwapScript } from '@/lib/utm-swap-script';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } }
) {
  const { data: page } = await db
    .from('pages')
    .select('id, html_url, html_content')
    .eq('slug', params.slug)
    .eq('is_published', true)
    .is('deleted_at', null)
    .single();

  if (!page) {
    return new NextResponse(notFoundHtml(), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  let html = page.html_content as string | null;

  if (!html) {
    try {
      html = await downloadHtmlByPath(fileNameFromUrl(page.html_url));
    } catch {
      return new NextResponse(notFoundHtml(), { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  }

  // Inject UTM swap script if rules exist for this page
  try {
    const [{ data: rules }, { data: pageRow }] = await Promise.all([
      db.from('personalization_rules')
        .select('match_param,match_value,is_fallback,overrides_json,conditions_json')
        .eq('page_id', page.id)
        .order('is_fallback', { ascending: true })
        .order('priority', { ascending: true }),
      db.from('pages').select('field_selectors_json').eq('id', page.id).single(),
    ]);

    if (rules && rules.length > 0) {
      const fieldSelectors = (pageRow as { field_selectors_json?: Record<string, string> } | null)?.field_selectors_json ?? null;
      const swapScript = buildUtmSwapScript(rules, fieldSelectors);
      html = html.includes('</body')
        ? html.replace('</body>', `${swapScript}\n</body>`)
        : html + swapScript;
    }
  } catch {
    // UTM injection failure must never block page delivery
  }

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, s-maxage=0',
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
