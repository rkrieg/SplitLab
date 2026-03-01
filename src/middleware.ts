import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

const APP_HOSTNAME = process.env.APP_HOSTNAME || 'splitlab.agency';

function isCustomDomain(host: string): boolean {
  return (
    !host.includes(APP_HOSTNAME) &&
    !host.includes('localhost') &&
    !host.includes('127.0.0.1') &&
    !host.includes('.vercel.app') &&
    !host.startsWith('192.168.')
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host') || '';

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
  const isAuthRoute = pathname.startsWith('/login');
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
