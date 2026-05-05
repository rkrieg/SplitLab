import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

const APP_HOSTNAME = process.env.APP_HOSTNAME || 'splitlab.agency';
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';
const NAKED_HOST = CANONICAL_HOST.replace(/^www\./, '');

const CNAME_BASE = process.env.CNAME_BASE || 'cname.trysplitlab.com';

function isCustomDomain(host: string): boolean {
  // Never treat Replit-managed domains as custom client domains
  if (host.includes('.replit.app') || host.includes('.replit.dev') || host.includes('.picard.replit.dev')) return false;
  // *.cname.trysplitlab.com subdomains ARE custom domains (direct CNAME access)
  if (host.endsWith(`.${CNAME_BASE}`)) return true;
  // Never treat the app's own exact hostname or www variant as a custom domain
  // Use exact/suffix match — NOT .includes() — so subdomains like ab.trysplitlab.com still route correctly
  if (APP_HOSTNAME && (host === APP_HOSTNAME || host === `www.${APP_HOSTNAME}`)) return false;
  // Never treat the canonical marketing domain as a custom domain
  if (CANONICAL_HOST && (host === CANONICAL_HOST || host === NAKED_HOST)) return false;
  // Standard exclusions
  if (host.includes('localhost') || host.includes('127.0.0.1') || host.startsWith('192.168.')) return false;
  return true;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host') || '';

  // ── Redirect naked domain → www (301) ─────────────────────────────────
  if (host === NAKED_HOST) {
    const url = request.nextUrl.clone();
    url.host = CANONICAL_HOST;
    return NextResponse.redirect(url, 301);
  }

  // ── Pages subdomain serving ────────────────────────────────────────────
  if (host === 'pages.trysplitlab.com') {
    const pageId = pathname.split('/')[1];
    if (pageId && pageId !== '_next' && !pageId.startsWith('api')) {
      const url = request.nextUrl.clone();
      url.pathname = `/api/pages/${pageId}/serve`;
      return NextResponse.rewrite(url);
    }
  }

  // ── Public tracking routes: bypass ALL middleware logic ────────────────
  const PUBLIC_PATHS = ['/api/event', '/api/resolve', '/tracker.js', '/api/pages/'];
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    const origin = request.headers.get('origin') || '*';
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    const res = NextResponse.next();
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Allow-Credentials', 'true');
    return res;
  }

  // ── Custom domain page serving ──────────────────────────────────────────
  // Only intercept requests on custom client domains. App routes, API routes,
  // and Next.js internals are never rewritten.
  const APP_ROUTES = [
    '/login', '/dashboard', '/clients', '/api', '/tests', '/pages',
    '/scripts', '/team', '/settings', '/_next', '/favicon.ico', '/static', '/tracker.js',
  ];
  const isAppRoute = APP_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/') || pathname.startsWith(r + '?'));

  if (isCustomDomain(host) && !isAppRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/api/serve';
    url.searchParams.set('domain', host);
    url.searchParams.set('path', pathname);
    return NextResponse.rewrite(url);
  }

  // ── Auth protection for dashboard routes ────────────────────────────────
  const isAuthRoute = pathname.startsWith('/login') || pathname.startsWith('/signup');
  const isDashboardRoute =
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/clients') ||
    pathname.startsWith('/team') ||
    pathname.startsWith('/settings');

  if (isDashboardRoute) {
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
    });

    if (!token) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Redirect logged-in users away from login page
  if (isAuthRoute) {
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
    });
    if (token) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
