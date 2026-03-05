import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { downloadHtml } from '@/lib/storage';
import { buildTrackingSnippet, injectIntoHtml, buildScriptTag } from '@/lib/tracking';
import { assignVariant } from '@/lib/utils';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const COOKIE_NAME = 'sl_visitor';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const domain = searchParams.get('domain') || '';
  const urlPath = searchParams.get('path') || '/';

  try {
    // 1. Resolve domain → workspace
    const { data: domainRow, error: domainError } = await db
      .from('domains')
      .select('workspace_id')
      .eq('domain', domain)
      .single();

    if (domainError || !domainRow) {
      return new NextResponse(notFoundHtml(domain), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const workspaceId = domainRow.workspace_id;

    // 2. Find active test matching this URL path
    const { data: test, error: testError } = await db
      .from('tests')
      .select('id, name, url_path')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .eq('url_path', urlPath)
      .single();

    if (testError || !test) {
      return new NextResponse(notFoundHtml(domain), {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 3. Fetch variants
    const { data: variants, error: variantsError } = await db
      .from('test_variants')
      .select('id, name, page_id, redirect_url, proxy_mode, traffic_weight, is_control, pages(html_url, html_content)')
      .eq('test_id', test.id)
      .order('is_control', { ascending: false });

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

    let selectedVariant = variants.find((v) => v.id === stickyVariantId);

    if (!selectedVariant) {
      selectedVariant = await assignVariant(visitorId, test.id, variants as { id: string; traffic_weight: number }[]) as typeof variants[0];
    }

    // 6a. If variant has a redirect URL
    if (selectedVariant.redirect_url) {
      console.log('[serve] redirect variant:', {
        id: selectedVariant.id,
        redirect_url: selectedVariant.redirect_url,
        proxy_mode: selectedVariant.proxy_mode,
        proxy_mode_type: typeof selectedVariant.proxy_mode,
        will_proxy: selectedVariant.proxy_mode !== false,
      });

      // Proxy mode: fetch remote HTML server-side and serve through custom domain
      if (selectedVariant.proxy_mode !== false) {
        let proxyHtml = '';
        try {
          console.log('[serve] proxy: fetching remote URL:', selectedVariant.redirect_url);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          const proxyRes = await fetch(selectedVariant.redirect_url, {
            signal: controller.signal,
            headers: {
              'User-Agent': request.headers.get('user-agent') || '',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': request.headers.get('accept-language') || 'en-US,en;q=0.5',
            },
            redirect: 'follow',
          });
          clearTimeout(timeout);

          console.log('[serve] proxy: remote response status:', proxyRes.status, 'content-type:', proxyRes.headers.get('content-type'));
          if (!proxyRes.ok) throw new Error(`Remote fetch failed: ${proxyRes.status}`);
          proxyHtml = await proxyRes.text();
          console.log('[serve] proxy: fetched HTML length:', proxyHtml.length);
        } catch (proxyErr) {
          // Fall back to 302 redirect if proxy fetch fails
          console.error('[serve] proxy fetch FAILED, falling back to redirect. Error:', proxyErr instanceof Error ? proxyErr.message : proxyErr);
          const redirectUrl = new URL(selectedVariant.redirect_url);
          redirectUrl.searchParams.set('sl_vid', selectedVariant.id);
          const fallbackResponse = NextResponse.redirect(redirectUrl.toString(), 302);
          const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 90, path: '/' };
          if (!existingCookie) fallbackResponse.cookies.set(COOKIE_NAME, visitorId, cookieOptions);
          if (!stickyVariantId) fallbackResponse.cookies.set(stickyCookieName, selectedVariant.id, cookieOptions);
          await db.from('events').insert({ test_id: test.id, variant_id: selectedVariant.id, visitor_hash: visitorId, type: 'pageview', metadata: { redirect_url: selectedVariant.redirect_url } });
          return fallbackResponse;
        }

        // Inject <base href> so relative assets resolve against the remote origin
        const remoteUrl = new URL(selectedVariant.redirect_url);
        const baseHref = remoteUrl.origin + remoteUrl.pathname.replace(/\/[^/]*$/, '/');
        const baseTag = `<base href="${baseHref}">`;
        if (proxyHtml.includes('<head>')) {
          proxyHtml = proxyHtml.replace('<head>', `<head>\n${baseTag}`);
        } else if (proxyHtml.includes('<HEAD>')) {
          proxyHtml = proxyHtml.replace('<HEAD>', `<HEAD>\n${baseTag}`);
        } else {
          proxyHtml = baseTag + '\n' + proxyHtml;
        }

        // Fetch workspace scripts
        const { data: proxyScripts } = await db
          .from('scripts')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('is_active', true)
          .is('page_id', null);

        const proxyHeadScripts: string[] = [];
        const proxyBodyEndScripts: string[] = [];
        for (const script of proxyScripts || []) {
          const tag = buildScriptTag(script.type, script.content);
          if (script.placement === 'head') proxyHeadScripts.push(tag);
          else proxyBodyEndScripts.push(tag);
        }

        // Fetch conversion goals and build tracking snippet
        const { data: proxyGoals } = await db
          .from('conversion_goals')
          .select('*')
          .eq('test_id', test.id);

        const proxyTrackingSnippet = buildTrackingSnippet(
          test.id, selectedVariant.id, visitorId, proxyGoals || [], APP_URL
        );

        const finalProxyHtml = injectIntoHtml(proxyHtml, proxyHeadScripts, proxyBodyEndScripts, proxyTrackingSnippet);

        // Record server-side pageview
        await db.from('events').insert({
          test_id: test.id,
          variant_id: selectedVariant.id,
          visitor_hash: visitorId,
          type: 'pageview',
          metadata: { redirect_url: selectedVariant.redirect_url, proxy: true },
        });

        const proxyResponse = new NextResponse(finalProxyHtml, {
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

    // 6b. Fetch HTML for variant
    let html = '';
    const pageData = (selectedVariant.pages as unknown) as { html_url: string; html_content: string | null } | null;

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
    const { data: scripts } = await db
      .from('scripts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('is_active', true)
      .is('page_id', null);

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
    const { data: goals } = await db
      .from('conversion_goals')
      .select('*')
      .eq('test_id', test.id);

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

function notFoundHtml(domain: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Not Found</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center}.code{font-size:4rem;font-weight:700;color:#3D8BDA}h1{margin:.5rem 0}p{color:#94a3b8}</style>
</head>
<body><div class="box"><div class="code">404</div><h1>Page Not Found</h1>
<p>No active test found for <strong>${domain}</strong></p></div></body>
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
