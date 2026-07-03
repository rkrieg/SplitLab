import { NextRequest, NextResponse } from 'next/server';

// Clears a NextAuth session whose user id no longer exists in the `users`
// table (e.g. stale JWT from a deleted/recreated account or a Supabase
// project swap), so the dashboard layout can force a real re-login instead
// of letting downstream FK-constrained inserts (pages.created_by, etc.) crash.
export async function GET(request: NextRequest) {
  const loginUrl = new URL('/login?expired=1', request.url);
  const response = NextResponse.redirect(loginUrl);
  response.cookies.delete('next-auth.session-token');
  response.cookies.delete('__Secure-next-auth.session-token');
  return response;
}
