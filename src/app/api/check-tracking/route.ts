import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { url, variant_id } = await request.json();
  if (!url || !variant_id) {
    return NextResponse.json({ error: 'url and variant_id required' }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'SplitLab-TrackingChecker/1.0' },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    const html = await res.text();

    // Check if tracker.js is present in the page HTML
    const trackerPatterns = [
      '/tracker.js',
      'tracker.js',
      APP_URL + '/tracker.js',
      'SplitLab',
      'sl_tracking',
    ];

    const verified = trackerPatterns.some((pattern) => html.includes(pattern));

    // Update the variant record
    await db
      .from('test_variants')
      .update({
        tracking_verified: verified,
        tracking_verified_at: new Date().toISOString(),
      })
      .eq('id', variant_id);

    return NextResponse.json({ verified, checked_at: new Date().toISOString() });
  } catch (err) {
    // Update as unverified on fetch failure
    await db
      .from('test_variants')
      .update({
        tracking_verified: false,
        tracking_verified_at: new Date().toISOString(),
      })
      .eq('id', variant_id);

    return NextResponse.json({
      verified: false,
      error: err instanceof Error ? err.message : 'Failed to fetch URL',
      checked_at: new Date().toISOString(),
    });
  }
}
