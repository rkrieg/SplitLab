import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

// Force this route to be evaluated only per-request, never at build time.
// Next.js App Router GET handlers are statically evaluated by default unless
// opted into dynamic rendering — without this, `npm run build` was actually
// *executing* the cron logic (real DB writes, real Anthropic API calls) to
// pre-render/cache a response, instead of running only on real invocations.
export const dynamic = 'force-dynamic';

import {
  filterRowsMatch,
  judgeUtmRowsMatch,
  mergePersonalizeHint,
  generateHeroOverrides,
  generateHeroRevamp,
  insertLiveAutoRule,
  type AutoRuleRow,
} from '@/lib/auto-personalize';

// UTM Personalization V2 pivot (2026-07-30, refined 2026-07-31 "PIVOT 3").
// See docs/utm-personalization-v2-automation.md. This job no longer discovers
// new audiences from a visitor-count threshold and surfaces them for human
// approval — the user now defines rules upfront as an ordered list of
// per-field rows (utm_auto_rules.rows: {field, look_for, personalize,
// instructions?}), and this job's job is to resolve literal filter rows,
// judge personalize rows' category hints via AI, then write live content
// directly with no approval step.
//
// Each new (rule, value-combination) pair is judged by AI at most once —
// the result is cached in utm_auto_rule_matches so repeat traffic with the
// same combination is a lookup, not a repeat AI call.

const LOOKBACK_DAYS = 30;

interface AggregateRow {
  page_id: string;
  utm_sig: string;
  utm: Record<string, string> | null;
  distinct_visitor_count: number;
}

function projectSignature(fields: string[], utm: Record<string, string>): string {
  return fields
    .map(f => `${f}=${(utm[f] ?? '').trim().toLowerCase()}`)
    .sort()
    .join('&');
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

    const { data: rows, error } = await db.rpc('utm_aggregate_pageviews', { since: since.toISOString() });
    if (error) throw error;

    const groups = (rows ?? []) as unknown as AggregateRow[];
    const pageIds = Array.from(new Set(groups.map(g => g.page_id)));
    console.log(`[cron/utm-detect] since=${since.toISOString()} utmCombinationsFound=${groups.length} pagesWithTraffic=${pageIds.length}`);
    if (pageIds.length === 0) {
      return NextResponse.json({ ok: true, pagesScanned: 0, rulesCreated: 0 });
    }

    const { data: autoRules } = await db
      .from('utm_auto_rules')
      .select('*')
      .eq('enabled', true)
      .in('page_id', pageIds);

    if (!autoRules || autoRules.length === 0) {
      console.log('[cron/utm-detect] no active auto-rules on any page with traffic — nothing to do');
      return NextResponse.json({ ok: true, pagesScanned: 0, rulesCreated: 0 });
    }

    const rulesByPage = new Map<string, typeof autoRules>();
    for (const r of autoRules) {
      const list = rulesByPage.get(r.page_id) ?? [];
      list.push(r);
      rulesByPage.set(r.page_id, list);
    }

    let rulesCreated = 0;
    let pagesScanned = 0;

    for (const [pageId, rules] of Array.from(rulesByPage.entries())) {
      const pageGroups = groups.filter(g => g.page_id === pageId);
      if (pageGroups.length === 0) continue;

      let pageRow: { id: string; schema_json: Record<string, unknown> | null; auto_field_selectors_json: Record<string, { selector: string; type: 'text' | 'image'; label: string }> | null; html_content: string | null; html_url: string | null } | null = null;

      for (const rule of rules) {
        const rows = (rule.rows ?? []) as AutoRuleRow[];
        // fields is no longer a stored column — derive it from the rule's
        // rows (dedup'd, since the same field can appear in multiple rows).
        const fields = Array.from(new Set(rows.map(r => r.field)));
        if (fields.length === 0) continue;

        // Project each traffic group onto just this rule's watched fields —
        // different rules on the same page can watch different field sets,
        // so the relevant "new combination" signature differs per rule.
        const projected = new Map<string, Record<string, string>>();
        for (const g of pageGroups) {
          const utm = g.utm ?? {};
          if (!fields.every((f: string) => utm[f]?.trim())) continue;
          const sig = projectSignature(fields, utm);
          if (!projected.has(sig)) projected.set(sig, utm);
        }
        if (projected.size === 0) continue;

        const { data: existingMatches } = await db
          .from('utm_auto_rule_matches')
          .select('utm_sig')
          .eq('auto_rule_id', rule.id);
        const alreadyJudged = new Set((existingMatches ?? []).map(m => m.utm_sig as string));

        for (const [sig, utm] of Array.from(projected.entries())) {
          if (alreadyJudged.has(sig)) continue;

          let matched = false;
          let personalizationRuleId: string | null = null;

          // Literal filter rows (personalize=false) resolve via cheap
          // case-insensitive contains-match — no AI call. If they fail, the
          // rule can never match this combination.
          if (!filterRowsMatch(rows, utm)) {
            await db.from('utm_auto_rule_matches').insert({
              auto_rule_id: rule.id, utm_sig: sig, utm, matched: false, personalization_rule_id: null,
            });
            continue;
          }

          const personalizeRows = rows.filter(r => r.personalize);
          try {
            // No personalize rows -> filters already passed -> matched, but
            // nothing to generate content for (pure filter rule).
            matched = personalizeRows.length === 0 ? true : await judgeUtmRowsMatch(rows, utm);
          } catch (err) {
            console.error(`[cron/utm-detect] judge failed rule=${rule.id} sig="${sig}"`, err);
            continue; // don't cache a failed judgment — retry next run
          }

          if (matched && personalizeRows.length > 0) {
            if (!pageRow) {
              const { data } = await db
                .from('pages')
                .select('id, schema_json, auto_field_selectors_json, html_content, html_url')
                .eq('id', pageId)
                .single();
              pageRow = data;
            }

            if (pageRow) {
              const conditions = fields.map((f: string) => ({ match_param: f, match_value: utm[f] }));
              const conditionDescription = conditions.map((c: { match_param: string; match_value: string }) => `${c.match_param} = "${c.match_value}"`).join(' AND ');
              const hint = mergePersonalizeHint(rows, utm);
              try {
                // Prefer a full hero-section revamp (content + layout + CTA
                // together) over the older field-by-field swap. Only
                // AI-generated pages carry the `section.hero` container
                // needed for this — raw/uploaded HTML pages return null here
                // and fall back to the field-swap path (explicit, tracked
                // gap, see docs/utm-personalization-v2-automation.md).
                const heroHtml = await generateHeroRevamp(pageRow, conditionDescription, hint);
                if (heroHtml) {
                  personalizationRuleId = await insertLiveAutoRule(pageId, conditions, {}, heroHtml);
                  if (personalizationRuleId) {
                    rulesCreated++;
                    console.log(`[cron/utm-detect] page=${pageId} rule=${rule.id} sig="${sig}" -> matched, live hero-revamp rule created`);
                  }
                } else {
                  const overrides = await generateHeroOverrides(pageRow, conditionDescription, hint);
                  if (overrides) {
                    personalizationRuleId = await insertLiveAutoRule(pageId, conditions, overrides);
                    if (personalizationRuleId) {
                      rulesCreated++;
                      console.log(`[cron/utm-detect] page=${pageId} rule=${rule.id} sig="${sig}" -> matched, live field-swap rule created`);
                    }
                  } else {
                    console.log(`[cron/utm-detect] page=${pageId} rule=${rule.id} sig="${sig}" -> matched but hero fields could not be detected`);
                  }
                }
              } catch (err) {
                console.error(`[cron/utm-detect] generation failed rule=${rule.id} sig="${sig}"`, err);
                continue; // don't cache — retry generation next run
              }
            }
          }

          await db.from('utm_auto_rule_matches').insert({
            auto_rule_id: rule.id,
            utm_sig: sig,
            utm,
            matched,
            personalization_rule_id: personalizationRuleId,
          });
        }
      }

      pagesScanned++;
    }

    console.log(`[cron/utm-detect] run complete: pagesScanned=${pagesScanned} rulesCreated=${rulesCreated}`);
    return NextResponse.json({ ok: true, pagesScanned, rulesCreated });
  } catch (err) {
    console.error('[cron/utm-detect]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
