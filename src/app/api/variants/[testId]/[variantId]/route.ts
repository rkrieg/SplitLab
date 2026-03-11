import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export async function GET(
  request: NextRequest,
  { params }: { params: { testId: string; variantId: string } }
) {
  const { testId, variantId } = params;

  try {
    // 1. Look up variant_pages record
    const { data: variantPage, error: vpErr } = await db
      .from('variant_pages')
      .select('*')
      .eq('variant_id', variantId)
      .eq('status', 'ready')
      .order('version', { ascending: false })
      .limit(1)
      .single();

    if (vpErr || !variantPage) {
      return new NextResponse(notFoundHtml(), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 2. Verify the variant belongs to the given test
    const { data: variant, error: varErr } = await db
      .from('test_variants')
      .select('id, test_id')
      .eq('id', variantId)
      .eq('test_id', testId)
      .single();

    if (varErr || !variant) {
      return new NextResponse(notFoundHtml(), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 3. Fetch HTML from Supabase Storage
    const { data: fileData, error: downloadErr } = await db.storage
      .from('variants')
      .download(variantPage.html_storage_path);

    if (downloadErr || !fileData) {
      console.error('[variant-host] download error:', downloadErr?.message);
      return new NextResponse(errorHtml(), {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    let html = await fileData.text();

    // 4. Build the sl_vid cookie/context script
    const slVidScript = `<script>
(function() {
  var params = new URLSearchParams(window.location.search);
  var vid = params.get('sl_vid') || ${JSON.stringify(variantId)};
  // Set sl_vid cookie (90 days)
  var expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = 'sl_test_${testId}=' + vid + ';path=/;expires=' + expires + ';SameSite=Lax';
  // Clean URL params
  if (params.has('sl_vid')) {
    params.delete('sl_vid');
    var qs = params.toString();
    var clean = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    history.replaceState(null, '', clean);
  }
})();
</script>`;

    // 5. Build tracker.js script tag
    const trackerTag = `<script src="${APP_URL}/tracker.js"></script>`;

    // 6. Inject before </body>
    const injection = `${slVidScript}\n${trackerTag}`;
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${injection}\n</body>`);
    } else {
      html += `\n${injection}`;
    }

    // 7. Check if the test is active for cache control
    const { data: test } = await db
      .from('tests')
      .select('status')
      .eq('id', testId)
      .single();

    const isActive = test?.status === 'active';
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
    console.error('[variant-host] error:', err);
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
</head><body><div class="box"><div class="code">404</div><h1>Variant Not Found</h1></div></body></html>`;
}

function errorHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Error</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center}.code{font-size:4rem;font-weight:700;color:#ef4444}</style>
</head><body><div class="box"><div class="code">500</div><h1>Server Error</h1></div></body></html>`;
}
