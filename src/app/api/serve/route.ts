import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { downloadHtml } from '@/lib/storage';
import { buildTrackingSnippet, injectIntoHtml, buildScriptTag } from '@/lib/tracking';
import { assignVariant } from '@/lib/utils';
import type { ConversionGoal } from '@/types';

const COOKIE_NAME = 'sl_visitor';

export async function GET(request: NextRequest) {
  const APP_URL = new URL(request.url).origin;
  const { searchParams } = new URL(request.url);
  const domain = searchParams.get('domain') || '';
  const urlPath = searchParams.get('path') || '/';

  try {
    // 1. Resolve domain → workspace by the client's actual domain name
    // Try exact match first, then fall back to www/naked normalization so
    // both "example.com" and "www.example.com" resolve to the same workspace.
    const domainVariants = Array.from(new Set([
      domain,
      domain.startsWith('www.') ? domain.slice(4) : `www.${domain}`,
    ]));

    let domainRow: { workspace_id: string; fallback_url: string | null } | null = null;
    for (const variant of domainVariants) {
      const result = await (db
        .from('domains')
        .select('workspace_id, fallback_url')
        .eq('domain', variant)
        .single() as unknown as Promise<{ data: { workspace_id: string; fallback_url: string | null } | null; error: { message: string } | null }>);
      if (result.data) { domainRow = result.data; break; }
    }

    if (!domainRow) {
      return new NextResponse(notFoundHtml(domain), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const workspaceId = domainRow.workspace_id;
    const fallbackUrl = domainRow.fallback_url;

    // 2. Find active test matching this URL path
    const { data: test, error: testError } = await (db
      .from('tests')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .eq('url_path', urlPath)
      .single() as unknown as Promise<{ data: { id: string; workspace_id: string; status: string; url_path: string; head_scripts?: string } | null; error: { message: string } | null }>);

    if (testError || !test) {
      // If no active test, redirect to fallback URL if configured
      if (fallbackUrl) {
        const fallback = new URL(fallbackUrl);
        fallback.pathname = fallback.pathname === '/' && urlPath !== '/' ? urlPath : fallback.pathname;
        return NextResponse.redirect(fallback.toString(), 302);
      }
      return new NextResponse(notFoundHtml(domain), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 3. Fetch variants
    const { data: variants, error: variantsError } = await (db
      .from('test_variants')
      .select('id, name, page_id, redirect_url, proxy_mode, traffic_weight, is_control, variant_type, hosted_url, pages(html_url, html_content)')
      .eq('test_id', test.id)
      .order('is_control', { ascending: false }) as unknown as Promise<{ data: { id: string; name: string; page_id: string | null; redirect_url: string | null; proxy_mode: boolean | null; traffic_weight: number; is_control: boolean; variant_type: string | null; hosted_url: string | null; pages: { html_url: string; html_content: string | null } | null }[] | null; error: { message: string; code?: string } | null }>);

    if (variantsError) {
      console.error('[serve] variants query error:', variantsError.message, variantsError.code);
    }

    if (!variants || variants.length === 0) {
      return new NextResponse(notFoundHtml(domain), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 4. Get or create session/visitor ID
    const existingCookie = request.cookies.get(COOKIE_NAME)?.value;
    const visitorId = existingCookie || crypto.randomUUID();

    // 5. Check for sticky assignment cookie for this specific test
    const stickyCookieName = `sl_test_${test.id}`;
    const stickyVariantId = request.cookies.get(stickyCookieName)?.value;

    // Honor sticky cookie only if that variant still has weight > 0
    let selectedVariant = variants.find(
      (v) => v.id === stickyVariantId && v.traffic_weight > 0
    );

    if (!selectedVariant) {
      selectedVariant = await assignVariant(visitorId, test.id, variants as { id: string; traffic_weight: number }[]) as typeof variants[0];
    }

    // 6a. If variant has a redirect URL
    if (selectedVariant.redirect_url) {
      // Guard: detect circular redirect — redirect URL points back to this same domain
      try {
        const redirectHost = new URL(selectedVariant.redirect_url).hostname.replace(/^www\./, '');
        const incomingHost = domain.replace(/^www\./, '');
        if (redirectHost === incomingHost) {
          return new NextResponse(circularRedirectHtml(domain, selectedVariant.name), {
            status: 409,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      } catch { /* invalid URL — let it fall through to natural error */ }

      // Proxy mode: serve iframe wrapper so URL stays on custom domain
      // The SPA runs in its original context inside the iframe
      if (selectedVariant.proxy_mode !== false) {
        // Fetch workspace scripts
        const { data: proxyScripts } = await (db
          .from('scripts')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('is_active', true)
          .is('page_id', null) as unknown as Promise<{ data: { type: string; content: string; placement: string }[] | null; error: unknown }>);

        const headScriptTags: string[] = [];
        const bodyEndScriptTags: string[] = [];
        for (const script of proxyScripts || []) {
          const tag = buildScriptTag(script.type, script.content);
          if (script.placement === 'head') headScriptTags.push(tag);
          else bodyEndScriptTags.push(tag);
        }

        // Fetch conversion goals and build tracking snippet
        const { data: proxyGoals } = await (db
          .from('conversion_goals')
          .select('*')
          .eq('test_id', test.id) as unknown as Promise<{ data: ConversionGoal[] | null; error: unknown }>);

        const proxyTrackingSnippet = buildTrackingSnippet(
          test.id, selectedVariant.id, visitorId, proxyGoals || [], APP_URL
        );

        const iframeUrl = selectedVariant.redirect_url;
        const testHeadScripts = test.head_scripts || '';
        const iframeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Loading…</title>
${testHeadScripts}
${headScriptTags.join('\n')}
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100vh;border:none;display:block}</style>
</head>
<body>
<iframe src="${iframeUrl}" allow="forms; scripts; same-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe>
${bodyEndScriptTags.join('\n')}
${proxyTrackingSnippet}
</body>
</html>`;

        const proxyResponse = new NextResponse(iframeHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });

        const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 90, path: '/' };
        if (!existingCookie) proxyResponse.cookies.set(COOKIE_NAME, visitorId, cookieOptions);
        if (!stickyVariantId) proxyResponse.cookies.set(stickyCookieName, selectedVariant.id, cookieOptions);

        return proxyResponse;
      }

      // Standard 302 redirect mode
      const redirectUrl = new URL(selectedVariant.redirect_url);
      redirectUrl.searchParams.set('sl_vid', selectedVariant.id);
      const redirectResponse = NextResponse.redirect(redirectUrl.toString(), 302);

      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        maxAge: 60 * 60 * 24 * 90,
        path: '/',
      };

      if (!existingCookie) {
        redirectResponse.cookies.set(COOKIE_NAME, visitorId, cookieOptions);
      }
      if (!stickyVariantId) {
        redirectResponse.cookies.set(stickyCookieName, selectedVariant.id, cookieOptions);
      }

      await db.from('events').insert({
        test_id: test.id,
        variant_id: selectedVariant.id,
        visitor_hash: visitorId,
        type: 'pageview',
        metadata: { redirect_url: selectedVariant.redirect_url },
      });

      return redirectResponse;
    }

    // 6b. Hosted AI variant — serve HTML directly with tracking injected
    if (selectedVariant.variant_type === 'hosted') {
      // Fetch variant_pages record for this variant
      const { data: variantPage } = await (db
        .from('variant_pages')
        .select('html_storage_path')
        .eq('variant_id', selectedVariant.id)
        .eq('status', 'ready')
        .order('version', { ascending: false })
        .limit(1)
        .single() as unknown as Promise<{ data: { html_storage_path: string } | null; error: unknown }>);

      if (variantPage) {
        const { data: fileData } = await db.storage
          .from('variants')
          .download(variantPage.html_storage_path);

        if (fileData) {
          let hostedHtml = await fileData.text();

          // Fetch workspace scripts
          const { data: hostedScripts } = await (db
            .from('scripts')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('is_active', true)
            .is('page_id', null) as unknown as Promise<{ data: { type: string; content: string; placement: string }[] | null; error: unknown }>);

          const hostedHeadScripts: string[] = [];
          const hostedBodyScripts: string[] = [];
          for (const script of hostedScripts || []) {
            const tag = buildScriptTag(script.type, script.content);
            if (script.placement === 'head') hostedHeadScripts.push(tag);
            else hostedBodyScripts.push(tag);
          }

          // Fetch conversion goals
          const { data: hostedGoals } = await (db
            .from('conversion_goals')
            .select('*')
            .eq('test_id', test.id) as unknown as Promise<{ data: ConversionGoal[] | null; error: unknown }>);

          const hostedTracking = buildTrackingSnippet(
            test.id, selectedVariant.id, visitorId, hostedGoals || [], APP_URL
          );

          hostedHtml = injectIntoHtml(hostedHtml, hostedHeadScripts, hostedBodyScripts, hostedTracking);

          const hostedResponse = new NextResponse(hostedHtml, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=300, s-maxage=300',
            },
          });

          const hostedCookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 90, path: '/' };
          if (!existingCookie) hostedResponse.cookies.set(COOKIE_NAME, visitorId, hostedCookieOptions);
          if (!stickyVariantId) hostedResponse.cookies.set(stickyCookieName, selectedVariant.id, hostedCookieOptions);

          return hostedResponse;
        }
      }
      // Fall through to regular HTML serving if hosted page not found
    }

    // 6c. Fetch HTML for variant
    let html = '';
    const pageData = selectedVariant.pages;

    if (pageData?.html_content) {
      html = pageData.html_content;
    } else if (pageData?.html_url) {
      try {
        html = await downloadHtml(pageData.html_url);
      } catch {
        html = '<html><body><p>Page content unavailable.</p></body></html>';
      }
    } else {
      return new NextResponse(notFoundHtml(domain), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 7. Fetch workspace scripts
    const { data: scripts } = await (db
      .from('scripts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('is_active', true)
      .is('page_id', null) as unknown as Promise<{ data: { type: string; content: string; placement: string }[] | null; error: unknown }>);

    const headScripts: string[] = [];
    const bodyEndScripts: string[] = [];

    for (const script of scripts || []) {
      const tag = buildScriptTag(script.type, script.content);
      if (script.placement === 'head') {
        headScripts.push(tag);
      } else {
        bodyEndScripts.push(tag);
      }
    }

    // 8. Fetch conversion goals
    const { data: goals } = await (db
      .from('conversion_goals')
      .select('*')
      .eq('test_id', test.id) as unknown as Promise<{ data: ConversionGoal[] | null; error: unknown }>);

    // 9. Build tracking snippet
    const visitorHash = visitorId;
    const trackingSnippet = buildTrackingSnippet(
      test.id,
      selectedVariant.id,
      visitorHash,
      goals || [],
      APP_URL
    );

    // 10. Inject everything into HTML
    const finalHtml = injectIntoHtml(html, headScripts, bodyEndScripts, trackingSnippet);

    // 11. Build response with sticky cookies
    const response = new NextResponse(finalHtml, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: 60 * 60 * 24 * 90, // 90 days
      path: '/',
    };

    if (!existingCookie) {
      response.cookies.set(COOKIE_NAME, visitorId, cookieOptions);
    }

    if (!stickyVariantId) {
      response.cookies.set(stickyCookieName, selectedVariant.id, cookieOptions);
    }

    return response;
  } catch (err) {
    console.error('[serve]', err);
    return new NextResponse(errorHtml(), {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

function circularRedirectHtml(domain: string, variantName: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Configuration Error</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;max-width:480px;padding:2rem}.icon{font-size:3rem;margin-bottom:1rem}
h1{margin:.5rem 0;font-size:1.5rem}p{color:#94a3b8;margin:.5rem 0;line-height:1.6}
.code{display:inline-block;background:#1e293b;border:1px solid #334155;border-radius:.375rem;padding:.25rem .75rem;font-family:monospace;font-size:.85rem;color:#f87171;margin:.5rem 0}
.hint{background:#1e293b;border:1px solid #334155;border-radius:.5rem;padding:1rem;margin-top:1.5rem;text-align:left;font-size:.85rem;color:#94a3b8}
.hint strong{color:#f8fafc}</style>
</head>
<body><div class="box">
<div class="icon">⚠️</div>
<h1>Circular Redirect Detected</h1>
<p>The <strong>${variantName}</strong> variant is pointing back to <span class="code">${domain}</span> — which routes through this same A/B test, creating an infinite loop.</p>
<div class="hint"><strong>How to fix:</strong> In SplitLab, edit this variant's Destination URL and set it to your site's <strong>direct hosting URL</strong> (e.g. your Vercel deployment URL), not your custom domain.</div>
</div></body>
</html>`;
}

function notFoundHtml(domain: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${domain}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#1e293b}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:3rem 2.5rem;text-align:center;max-width:420px;width:90%;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:1.25rem;font-weight:600;margin-bottom:.5rem;color:#0f172a}
p{font-size:.9rem;color:#64748b;line-height:1.6}
.badge{display:inline-flex;align-items:center;gap:.4rem;font-size:.75rem;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:.3rem .75rem;color:#64748b;margin-bottom:1.5rem;font-family:monospace}
.dot{width:6px;height:6px;border-radius:50%;background:#22c55e;display:inline-block}
</style>
</head>
<body>
<div class="card">
  <div class="badge"><span class="dot"></span>${domain}</div>
  <h1>Coming Soon</h1>
  <p>This page is currently being set up. Check back shortly.</p>
</div>
</body>
</html>`;
}

function errorHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Error</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center}.code{font-size:4rem;font-weight:700;color:#ef4444}</style>
</head>
<body><div class="box"><div class="code">500</div><h1>Server Error</h1></div></body>
</html>`;
}
