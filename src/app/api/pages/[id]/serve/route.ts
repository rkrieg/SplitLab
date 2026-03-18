import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { downloadHtml } from '@/lib/storage';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id: pageId } = params;

  try {
    // Fetch page from DB
    const { data: page, error: pageErr } = await db
      .from('pages')
      .select('*')
      .eq('id', pageId)
      .single();

    if (pageErr || !page) {
      return new NextResponse(notFoundHtml(), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Get HTML content
    let html: string;
    if (page.html_content) {
      html = page.html_content;
    } else if (page.html_url) {
      html = await downloadHtml(page.html_url);
    } else {
      return new NextResponse(notFoundHtml(), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Inject tracker.js before </body>
    const trackerScript = `<script>
(function() {
  var pageId = ${JSON.stringify(pageId)};
  // Set page context cookie
  var expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = 'sl_page=' + pageId + ';path=/;expires=' + expires + ';SameSite=Lax';
})();
</script>
<script src="${APP_URL}/tracker.js"></script>`;

    if (html.includes('</body>')) {
      html = html.replace('</body>', `${trackerScript}\n</body>`);
    } else {
      html += `\n${trackerScript}`;
    }

    const isActive = page.status === 'active';
    const cacheControl = isActive
      ? 'public, max-age=300, s-maxage=300'
      : 'public, max-age=3600, s-maxage=3600';

    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': cacheControl,
      },
    });
  } catch (err) {
    console.error('[page-serve] error:', err);
    return new NextResponse(errorHtml(), {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

function notFoundHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Not Found</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center}.code{font-size:4rem;font-weight:700;color:#3D8BDA}</style>
</head><body><div class="box"><div class="code">404</div><h1>Page Not Found</h1></div></body></html>`;
}

function errorHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Error</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center}.code{font-size:4rem;font-weight:700;color:#ef4444}</style>
</head><body><div class="box"><div class="code">500</div><h1>Server Error</h1></div></body></html>`;
}
