/**
 * SplitLab Proxy Worker
 *
 * Deploy this to Cloudflare Workers and attach it to the `proxy.trysplitlab.com` route.
 *
 * How it works:
 *   1. Customer CNAMEs their subdomain (e.g. test.theirdomain.com) → proxy.trysplitlab.com
 *   2. This worker receives all those requests
 *   3. It reads the Host header (the customer's actual domain) and the URL path
 *   4. It proxies to SplitLab's serve API which handles A/B test routing
 *
 * Setup:
 *   1. wrangler deploy  (or paste into the Cloudflare Workers dashboard)
 *   2. Add a Custom Domain: proxy.trysplitlab.com → this worker
 *   3. Done — no per-customer configuration ever needed
 */

const SPLITLAB_SERVE_URL = 'https://www.trysplitlab.com/api/serve';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = request.headers.get('host') || '';

    // Build the proxied request to SplitLab's serve route
    const target = new URL(SPLITLAB_SERVE_URL);
    target.searchParams.set('domain', host);
    target.searchParams.set('path', url.pathname || '/');

    // Forward relevant headers; set x-forwarded-host so SplitLab can read the real host if needed
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      // Skip host — we're changing the destination
      if (key.toLowerCase() === 'host') continue;
      forwardHeaders.set(key, value);
    }
    forwardHeaders.set('x-forwarded-host', host);
    forwardHeaders.set('x-splitlab-proxy', '1');

    const proxyRequest = new Request(target.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
      redirect: 'manual',
    });

    try {
      const response = await fetch(proxyRequest);

      // Pass through the response as-is (including cookies, headers, status)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      return new Response('Gateway error', { status: 502 });
    }
  },
};
