import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { downloadHtml } from '@/lib/storage';
import { buildTrackingSnippet, buildScanScript, injectIntoHtml, buildScriptTag, buildFaviconTag, stripFaviconTags } from '@/lib/tracking';
import { assignVariant } from '@/lib/utils';
import { getPlanDetails } from '@/lib/plans';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const COOKIE_NAME = 'sl_visitor';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const domain = searchParams.get('domain') || '';
  const urlPath = searchParams.get('path') || '/';
  const isScan = searchParams.get('sl_scan') === '1';
  const forcedVid = searchParams.get('sl_vid') || null;
  const forcedVh = searchParams.get('sl_vh') || null;

  try {
    const previewTestId = searchParams.get('preview_test_id') || null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let test: any;
    let workspaceId: string;
    let clientLogoUrl: string | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extractLogoUrl = (wsData: any): string | null => {
      // Supabase may return nested relations as array or object
      const ws = Array.isArray(wsData) ? wsData[0] : wsData;
      const clients = ws?.clients;
      const clientRow = Array.isArray(clients) ? clients[0] : clients;
      return clientRow?.logo_url ?? null;
    };

    if (previewTestId) {
      // Preview mode: dashboard "Open" with no custom domain configured.
      // Look up the test directly by ID — skip domain resolution and status filter.
      const { data: testRow, error: testErr } = await db
        .from('tests')
        .select('*, workspaces(clients(logo_url))')
        .eq('id', previewTestId)
        .single();

      if (testErr || !testRow) {
        return new NextResponse(notFoundHtml('preview'), {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      // Real traffic (no sl_vh) only serves active tests. Dashboard preview (sl_vh) bypasses this.
      if (testRow.status !== 'active' && !forcedVh) {
        return new NextResponse(notFoundHtml('preview'), {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      test = testRow;
      workspaceId = testRow.workspace_id;
      clientLogoUrl = extractLogoUrl(testRow.workspaces);
    } else {
      // 1. Resolve domain → workspace (+ client logo for favicon injection)
      const { data: domainRow, error: domainError } = await db
        .from('domains')
        .select('workspace_id, workspaces(clients(logo_url))')
        .eq('domain', domain)
        .single();

      if (domainError || !domainRow) {
        return new NextResponse(notFoundHtml(domain), {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      workspaceId = domainRow.workspace_id;
      clientLogoUrl = extractLogoUrl(domainRow.workspaces);

      // 2. Find active test matching this URL path
      const { data: testRow, error: testError } = await db
        .from('tests')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('status', 'active')
        .eq('url_path', urlPath)
        .single();

      if (testError || !testRow) {
        return new NextResponse(notFoundHtml(domain), {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      test = testRow;
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
    // forcedVh: passed by the dashboard Open button to simulate a fresh visitor each time
    const existingCookie = request.cookies.get(COOKIE_NAME)?.value;
    const visitorId = forcedVh || existingCookie || crypto.randomUUID();

    // 4b. Visitor cap check (skip for scan and Open-button/forcedVh and returning visitors)
    // previewTestId is NOT excluded — for free users the preview URL is the real traffic URL
    let overVisitorCap = false;
    if (!isScan && !forcedVh && !existingCookie) {
      // Resolve workspace → client → owner
      const { data: wsRow } = await db
        .from('workspaces')
        .select('client_id, clients(owner_id)')
        .eq('id', workspaceId)
        .single();

      // Supabase may return clients as array or object depending on relationship definition
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientsData = wsRow?.clients as any;
      const ownerId: string | undefined = Array.isArray(clientsData)
        ? clientsData[0]?.owner_id
        : clientsData?.owner_id;

      if (ownerId) {
        const { data: ownerRow } = await db
          .from('users')
          .select('plan, role')
          .eq('id', ownerId)
          .single();

        const ownerRole = ownerRow?.role ?? 'manager';
        const ownerPlan = ownerRow?.plan ?? 'free';

        // Admins bypass all limits
        if (ownerRole !== 'admin') {
          const planDetails = getPlanDetails(ownerPlan);

          if (isFinite(planDetails.monthlyVisitors)) {
            // Count all owner's tests to scope the visitor query
            const { data: ownerTests } = await db
              .from('tests')
              .select('id, workspaces!inner(client_id, clients!inner(owner_id))')
              .eq('workspaces.clients.owner_id', ownerId);

            // Always include the current test.id — the ownership join may miss it
            const ownerTestIds = Array.from(new Set([test.id, ...(ownerTests ?? []).map((t) => t.id)]));

            if (ownerTestIds.length > 0) {
              const monthStart = new Date();
              monthStart.setUTCDate(1);
              monthStart.setUTCHours(0, 0, 0, 0);

              const { data: visitorRows } = await db
                .from('events')
                .select('visitor_hash')
                .eq('type', 'pageview')
                .in('test_id', ownerTestIds)
                .gte('created_at', monthStart.toISOString());

              const uniqueCount = new Set((visitorRows ?? []).map((r: { visitor_hash: string }) => r.visitor_hash)).size;
              overVisitorCap = uniqueCount >= planDetails.monthlyVisitors;
            }
          }
        }
      }
    }

    // 5. Check for sticky assignment cookie for this specific test
    const stickyCookieName = `sl_test_${test.id}`;
    const stickyVariantId = request.cookies.get(stickyCookieName)?.value;

    // forcedVid: used by scan/preview to explicitly request a specific variant
    let selectedVariant = forcedVid
      ? (variants.find((v) => v.id === forcedVid) ?? variants.find((v) => v.id === stickyVariantId))
      : variants.find((v) => v.id === stickyVariantId);

    if (!selectedVariant) {
      selectedVariant = await assignVariant(visitorId, test.id, variants as { id: string; traffic_weight: number }[]) as typeof variants[0];
    }

    // 6a. If variant has a redirect URL
    if (selectedVariant.redirect_url) {
      // Proxy mode: serve iframe wrapper so URL stays on custom domain
      // The SPA runs in its original context inside the iframe
      if (selectedVariant.proxy_mode !== false) {
        // Fetch workspace scripts + page-scoped scripts + test-scoped scripts
        const [{ data: proxyWorkspaceScripts }, { data: proxyPageScripts }, { data: proxyTestScripts }] = await Promise.all([
          db.from('scripts').select('*').eq('workspace_id', workspaceId).eq('is_active', true).is('page_id', null).is('test_id', null),
          selectedVariant.page_id
            ? db.from('scripts').select('*').eq('workspace_id', workspaceId).eq('is_active', true).eq('page_id', selectedVariant.page_id)
            : Promise.resolve({ data: [] }),
          db.from('scripts').select('*').eq('workspace_id', workspaceId).eq('is_active', true).eq('test_id', test.id),
        ]);
        const proxyScripts = [...(proxyWorkspaceScripts || []), ...(proxyPageScripts || []), ...(proxyTestScripts || [])];

        const testHeadScriptsProxy = (test as { head_scripts?: string }).head_scripts || '';
        const headScriptTags: string[] = testHeadScriptsProxy ? [testHeadScriptsProxy] : [];
        const bodyEndScriptTags: string[] = [];
        for (const script of proxyScripts) {
          const tag = buildScriptTag(script.type, script.content);
          if (script.placement === 'head') headScriptTags.push(tag);
          else bodyEndScriptTags.push(tag);
        }

        // Fetch conversion goals and build tracking snippet
        const { data: proxyGoals } = await db
          .from('conversion_goals')
          .select('*')
          .eq('test_id', test.id);

        const proxyTrackingSnippet = (overVisitorCap || forcedVh) ? '' : buildTrackingSnippet(
          test.id, selectedVariant.id, visitorId, proxyGoals || [], APP_URL
        );

        const iframeUrlObj = new URL(selectedVariant.redirect_url);
        iframeUrlObj.searchParams.set('sl_vid', selectedVariant.id);
        iframeUrlObj.searchParams.set('sl_vh', visitorId);
        if (isScan) iframeUrlObj.searchParams.set('sl_scan', '1');
        const iframeUrl = iframeUrlObj.toString();
        const iframeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Loading…</title>
${clientLogoUrl ? buildFaviconTag(clientLogoUrl) : ''}
${headScriptTags.join('\n')}
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100vh;border:none;display:block}</style>
</head>
<body>
<iframe src="${iframeUrl}" allow="forms; scripts; same-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe>
${bodyEndScriptTags.join('\n')}
${proxyTrackingSnippet}
</body>
</html>`;

        // Record server-side pageview (skip for cap, scan, and Open-button previews)
        if (!overVisitorCap && !isScan && !forcedVh) {
          await db.from('events').insert({
            test_id: test.id,
            variant_id: selectedVariant.id,
            visitor_hash: visitorId,
            type: 'pageview',
            metadata: { redirect_url: selectedVariant.redirect_url, proxy: true },
          });
        }

        const proxyResponse = new NextResponse(iframeHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });

        const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 90, path: '/' };
        if (!existingCookie && !overVisitorCap && !isScan && !forcedVh) proxyResponse.cookies.set(COOKIE_NAME, visitorId, cookieOptions);
        if (!stickyVariantId && !isScan && !forcedVh) proxyResponse.cookies.set(stickyCookieName, selectedVariant.id, cookieOptions);

        return proxyResponse;
      }

      // Standard 302 redirect mode
      const redirectUrl = new URL(selectedVariant.redirect_url);
      redirectUrl.searchParams.set('sl_vid', selectedVariant.id);
      redirectUrl.searchParams.set('sl_vh', visitorId);
      if (isScan) redirectUrl.searchParams.set('sl_scan', '1');
      const redirectResponse = NextResponse.redirect(redirectUrl.toString(), 302);

      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        maxAge: 60 * 60 * 24 * 90,
        path: '/',
      };

      if (!existingCookie && !overVisitorCap && !isScan && !forcedVh) {
        redirectResponse.cookies.set(COOKIE_NAME, visitorId, cookieOptions);
      }
      if (!stickyVariantId && !isScan && !forcedVh) {
        redirectResponse.cookies.set(stickyCookieName, selectedVariant.id, cookieOptions);
      }

      if (!overVisitorCap && !isScan && !forcedVh) {
        await db.from('events').insert({
          test_id: test.id,
          variant_id: selectedVariant.id,
          visitor_hash: visitorId,
          type: 'pageview',
          metadata: { redirect_url: selectedVariant.redirect_url },
        });
      }

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

    // 7. Fetch workspace scripts + page-scoped scripts + test-scoped scripts
    const [{ data: workspaceScripts }, { data: pageScripts }, { data: testScripts }] = await Promise.all([
      db.from('scripts').select('*').eq('workspace_id', workspaceId).eq('is_active', true).is('page_id', null).is('test_id', null),
      selectedVariant.page_id
        ? db.from('scripts').select('*').eq('workspace_id', workspaceId).eq('is_active', true).eq('page_id', selectedVariant.page_id)
        : Promise.resolve({ data: [] }),
      db.from('scripts').select('*').eq('workspace_id', workspaceId).eq('is_active', true).eq('test_id', test.id),
    ]);
    const scripts = [...(workspaceScripts || []), ...(pageScripts || []), ...(testScripts || [])];

    const testHeadScriptsHtml = (test as { head_scripts?: string }).head_scripts || '';
    const headScripts: string[] = testHeadScriptsHtml ? [testHeadScriptsHtml] : [];
    const bodyEndScripts: string[] = [];

    for (const script of scripts) {
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

    // 9. Build tracking snippet (skip for cap, scan, and Open-button previews)
    const visitorHash = visitorId;
    const trackingSnippet = (overVisitorCap || forcedVh) ? '' : buildTrackingSnippet(
      test.id,
      selectedVariant.id,
      visitorHash,
      goals || [],
      APP_URL
    );

    // 10. Inject everything into HTML
    if (clientLogoUrl) {
      // Client logo always wins: strip the page's own favicon links first
      html = stripFaviconTags(html);
      headScripts.push(buildFaviconTag(clientLogoUrl));
    }
    if (isScan) bodyEndScripts.push(buildScanScript(selectedVariant.id, APP_URL));
    const finalHtml = injectIntoHtml(html, headScripts, bodyEndScripts, trackingSnippet);

    // 10b. Record pageview (skip for cap, scan, and Open-button previews)
    if (!overVisitorCap && !isScan && !forcedVh) {
      await db.from('events').insert({
        test_id: test.id,
        variant_id: selectedVariant.id,
        visitor_hash: visitorId,
        type: 'pageview',
        metadata: {},
      });
    }

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

    if (!existingCookie && !overVisitorCap && !isScan && !forcedVh) {
      response.cookies.set(COOKIE_NAME, visitorId, cookieOptions);
    }

    if (!stickyVariantId && !isScan && !forcedVh) {
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
