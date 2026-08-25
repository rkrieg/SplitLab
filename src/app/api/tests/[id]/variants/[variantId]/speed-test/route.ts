import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 120; // PageSpeed runs are slow

// Google PageSpeed Insights (Lighthouse) performance score, 0-100.
// Returns the score plus the HTTP status so the caller can tell a rate-limit
// (429 — usually a missing PAGESPEED_API_KEY) apart from an unreachable page.
async function psiScore(url: string, strategy: 'mobile' | 'desktop'): Promise<{ score: number | null; status: number }> {
  const key = process.env.PAGESPEED_API_KEY;
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance${key ? `&key=${key}` : ''}`;
  try {
    const res = await fetch(api, { cache: 'no-store' });
    if (!res.ok) return { score: null, status: res.status };
    const data = await res.json();
    const score = data?.lighthouseResult?.categories?.performance?.score;
    return { score: typeof score === 'number' ? Math.round(score * 100) : null, status: 200 };
  } catch {
    return { score: null, status: 0 };
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string; variantId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: variant } = await db
    .from('test_variants')
    .select('id, test_id, redirect_url, page_id')
    .eq('id', params.variantId)
    .single();
  if (!variant || variant.test_id !== params.id) return NextResponse.json({ error: 'Variant not found' }, { status: 404 });

  const { data: test } = await db.from('tests').select('workspace_id, url_path').eq('id', params.id).single();
  if (!test) return NextResponse.json({ error: 'Test not found' }, { status: 404 });

  const role = await resolveWorkspaceRole(test.workspace_id, session.user.id, session.user.role);
  if (!role || role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Resolve a publicly reachable URL PageSpeed can load.
  // sl_vid forces this exact variant; sl_vh (a throwaway hash) makes it a clean
  // serve — bypasses the visitor cap, records no pageview, sets no cookies, and
  // skips the page-scanner script — so a speed test never pollutes analytics.
  // Use THIS deployment's own origin so a staging dashboard speed-tests the
  // staging serve route (not whatever NEXT_PUBLIC_APP_URL points at).
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('host');
  const APP_URL = host ? `${proto}://${host}` : (process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com');
  const vh = crypto.randomUUID();
  let url: string | null = null;
  if (variant.redirect_url) {
    url = variant.redirect_url;
  } else if (variant.page_id) {
    const path = test.url_path || '/';
    const { data: dom } = await db
      .from('domains')
      .select('domain')
      .eq('workspace_id', test.workspace_id)
      .eq('verified', true)
      .limit(1)
      .maybeSingle();
    if (dom?.domain) {
      const sep = path.includes('?') ? '&' : '?';
      url = `https://${dom.domain}${path}${sep}sl_vid=${variant.id}&sl_vh=${vh}`;
    } else {
      // No custom domain — use the app's own public serve URL for this variant.
      url = `${APP_URL}/api/serve?preview_test_id=${params.id}&sl_vid=${variant.id}&sl_vh=${vh}`;
    }
  }
  if (!url) {
    return NextResponse.json({ error: 'This variant has no page to speed-test yet.' }, { status: 400 });
  }

  const [m, d] = await Promise.all([psiScore(url, 'mobile'), psiScore(url, 'desktop')]);
  const mobile = m.score, desktop = d.score;
  if (mobile == null && desktop == null) {
    const rateLimited = m.status === 429 || d.status === 429;
    return NextResponse.json({
      error: rateLimited
        ? 'PageSpeed daily quota reached. Add a free PAGESPEED_API_KEY to enable speed tests.'
        : 'PageSpeed could not load this page. Try again.',
      rateLimited,
    }, { status: 502 });
  }

  const testedAt = new Date().toISOString();
  // Best-effort persist — succeeds once migration 060 is applied; scores still
  // return even if the columns aren't there yet.
  await db.from('test_variants').update({ speed_mobile: mobile, speed_desktop: desktop, speed_tested_at: testedAt } as never).eq('id', variant.id);

  return NextResponse.json({ mobile, desktop, testedAt });
}
