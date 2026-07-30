import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

// UTM Personalization V2 (auto-detection) — background detection job.
// See docs/utm-personalization-v2-automation.md for the full design.
//
// Runs on a fixed, frequent baseline schedule (see vercel.json — every 15
// minutes), but each page's own `scan_interval_minutes` setting (default 45)
// governs how often it is actually re-evaluated: a page is skipped until
// that many minutes have passed since its `last_scanned_at`. This is how a
// per-page-adjustable interval is reconciled with Vercel Cron only
// supporting one fixed schedule per entry.
//
// KNOWN LIMITATION: this does not yet check whether a `personalization_rules`
// row already covers a detected combination before surfacing it again as
// 'notified' — a combination that already has a manually-authored rule can
// still show up here. Left as a follow-up; low-risk since the UTM screen
// lets the user dismiss/reject it either way.

const LOOKBACK_DAYS = 30;
const DEFAULT_THRESHOLD = 8;
const DEFAULT_INTERVAL_MINUTES = 45;

interface AggregateRow {
  page_id: string;
  utm_sig: string;
  utm: Record<string, string> | null;
  distinct_visitor_count: number;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  console.log('[cron/utm-detect] started');

  try {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - LOOKBACK_DAYS);

    // Aggregation (join + group by + distinct-visitor count) runs as a SQL
    // function (utm_aggregate_pageviews, migration 042) instead of pulling
    // raw event rows into Node and reducing them here — events grow fast
    // (every pageview, every client), so this has to scale in the database,
    // not in a JS Map.
    const { data: rows, error } = await db.rpc('utm_aggregate_pageviews', { since: since.toISOString() });

    if (error) throw error;

    const groups = (rows ?? []) as unknown as AggregateRow[];

    const pageIds = Array.from(new Set(groups.map(g => g.page_id)));
    console.log(`[cron/utm-detect] since=${since.toISOString()} utmCombinationsFound=${groups.length} pagesWithTraffic=${pageIds.length}`);
    if (pageIds.length === 0) {
      console.log('[cron/utm-detect] no pageview events with a utm_sig found in the lookback window — nothing to do');
      return NextResponse.json({ ok: true, pagesScanned: 0 });
    }

    const { data: settingsRows } = await db
      .from('utm_detection_settings')
      .select('*')
      .in('page_id', pageIds);

    const settingsByPage = new Map((settingsRows ?? []).map(s => [s.page_id as string, s]));

    const now = new Date();
    let pagesScanned = 0;

    for (const pageId of pageIds) {
      const settings = settingsByPage.get(pageId);
      const intervalMinutes = settings?.scan_interval_minutes ?? DEFAULT_INTERVAL_MINUTES;
      const threshold = settings?.visitor_threshold ?? DEFAULT_THRESHOLD;

      if (settings?.last_scanned_at) {
        const elapsedMs = now.getTime() - new Date(settings.last_scanned_at).getTime();
        if (elapsedMs < intervalMinutes * 60_000) continue; // not due yet
      }

      const pageGroups = groups.filter(g => g.page_id === pageId);

      const { data: existingDetections } = await db
        .from('utm_auto_detections')
        .select('id, utm_sig, status')
        .eq('page_id', pageId);

      const existingBySig = new Map((existingDetections ?? []).map(d => [d.utm_sig as string, d]));

      let newlyNotified = 0;

      for (const g of pageGroups) {
        const distinctVisitorCount = g.distinct_visitor_count;
        const existing = existingBySig.get(g.utm_sig);

        if (!existing) {
          const willNotify = distinctVisitorCount >= threshold;
          await db.from('utm_auto_detections').insert({
            page_id: pageId,
            utm_sig: g.utm_sig,
            utm: g.utm ?? {},
            distinct_visitor_count: distinctVisitorCount,
            status: willNotify ? 'notified' : 'pending',
            notified_at: willNotify ? now.toISOString() : null,
            last_seen_at: now.toISOString(),
          });
          if (willNotify) newlyNotified++;
          console.log(
            `[cron/utm-detect] page=${pageId} utm_sig="${g.utm_sig}" visitors=${distinctVisitorCount}/${threshold} -> ${willNotify ? 'notified (new)' : 'pending (new)'}`
          );
          continue;
        }

        const shouldNotify = existing.status === 'pending' && distinctVisitorCount >= threshold;
        await db
          .from('utm_auto_detections')
          .update({
            distinct_visitor_count: distinctVisitorCount,
            last_seen_at: now.toISOString(),
            ...(shouldNotify ? { status: 'notified', notified_at: now.toISOString() } : {}),
            updated_at: now.toISOString(),
          })
          .eq('id', existing.id);
        if (shouldNotify) {
          newlyNotified++;
          console.log(`[cron/utm-detect] page=${pageId} utm_sig="${g.utm_sig}" visitors=${distinctVisitorCount}/${threshold} -> notified (threshold crossed)`);
        }
      }

      // Upsert last_scanned_at, creating the settings row with defaults if this
      // is the first time this page has ever been scanned.
      await db
        .from('utm_detection_settings')
        .upsert({ page_id: pageId, last_scanned_at: now.toISOString() }, { onConflict: 'page_id' });

      pagesScanned++;
      console.log(`[cron/utm-detect] page=${pageId} combinations=${pageGroups.length} newlyNotified=${newlyNotified}`);
    }

    console.log(`[cron/utm-detect] run complete: pagesScanned=${pagesScanned} totalPagesWithTraffic=${pageIds.length}`);
    return NextResponse.json({ ok: true, pagesScanned });
  } catch (err) {
    console.error('[cron/utm-detect]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
