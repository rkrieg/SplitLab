# Analytics / Tracking Bugs — Oodles Investigation (2026-07-21/22)

## Handoff Summary (read this first, plain English)

**What we were trying to figure out:** Oodles client said SplitLab is showing way fewer
visitors/conversions than Unbounce for the same live traffic. We dug through the tracking code
and database to find out why.

**What we found — 6 real bugs, none of them the actual answer:**

1. **Dashboard cuts off data at 1,000 rows** — Supabase only returns 1,000 rows by default, and
   the dashboard query never asks for more or sorts them. So on any test with more than 1,000
   events, the dashboard is silently blind to some of the data (in this case, it was missing the
   entire most recent week every time). **Not fixed yet.**
2. **Conversion rate formula is slightly off** vs. how Unbounce calculates it — minor, checked
   the math, it only moves the number by a fraction of a percent. **Not the cause of the gap,
   low priority to fix.**
3. **A single click can get counted as a "conversion" multiple times** because the duplicate-
   click protection isn't strict enough. Real bug, but it only inflates the click count — it
   doesn't hide visitors.
4. **The actual root cause of bug 3's duplication**: when we build the tracking code sent to a
   visitor's browser, we grab ALL the test's goals (one per variant, e.g. 5 variants = 5 goals),
   not just the goal for the variant that visitor is actually seeing. Since all 5 goals were set
   up with the same button text, one real click ends up firing 5 duplicate conversion events.
   This explains why "goal hits" looked way higher than actual converting people. **Not fixed
   yet — the fix is a one-line change to scope the goals query to the visitor's variant.**
5. **Page views have no duplicate protection** on the server-side insert — every reload counts
   as a new view. Turned out this is fine / not actually double-counting anything (tested and
   confirmed), just worth knowing it behaves more like Unbounce's "Views" than "Visitors."
6. **A handful of conversions get "lost"** because the goal-matching logic couldn't tie them to
   a specific goal, so they get saved with no goal attached and become invisible on the
   dashboard. Small in this case (1 out of 100), but worth a periodic check.
7. **Dashboard dates are UTC, not the viewer's local time** — so someone checking "today's"
   numbers in the evening can see zero events even though real events happened, because their
   local "today" and the database's UTC "today" don't line up. **Not fixed yet.**

**The big unsolved mystery:** even after accounting for all of the above, SplitLab is still
showing ~11-14x fewer visitors than Unbounce for the exact same time period and variant. None of
the 7 bugs above — alone or combined — explain a gap that large. Our best guess right now is that
some of the real traffic simply never passes through SplitLab at all (e.g. an ad campaign
pointing at a different URL, or DNS/CDN not fully routing everything through SplitLab's
middleware) — but this is unconfirmed.

**What to do first thing tomorrow:**
1. Ask the client/media buyer to confirm the *exact* URL(s) their ad traffic points to — make
   sure it's really only `start.oodlesofleads.com/oodles` and nothing else.
2. Double check the domain's DNS/CDN setup is fully and consistently pointing to SplitLab (not
   partially cached or serving an old version somewhere).
3. Once traffic routing is confirmed clean, re-run the comparison query (see "Query reference"
   section at the bottom of this doc) on a short, fresh time window to see if the gap shrinks.
4. Separately (lower priority, whenever there's time): implement the still-pending fixes — Bug 1
   (row cap), Bug 3a (goals scoping), Bug 6 (timezone) — none of these are the root cause of the
   big gap, but they're real bugs worth fixing regardless.

---

Investigation trigger: Oodles client's test (`test_id: 33cbacc2-4a2b-4ce3-b9fb-618be61a6c04`,
domain `start.oodlesofleads.com/oodles`, variants: Testing Variant, AH, AE, AG, AD (control), AK)
reported drastically lower views/conversions than Unbounce for the same real production traffic.

Scoped, correct, same-window comparison (Jun 19 – Jul 22, Variant AD only):

| Metric | Unbounce | SplitLab | Ratio |
|---|---|---|---|
| Visitors | 2,600 | 231 | ~11x lower |
| Views | 3,700 | 255 | ~14.5x lower |
| Conversions | 839 | 4 (unique) / 39 (goal hits) | ~200x / ~21x lower |

This gap is **still unexplained** after fixing/ruling out every bug below — see "Still Open" at
the bottom. The bugs documented here are real, confirmed, and worth fixing regardless, but none
of them individually (or combined) accounts for an 11-14x raw traffic gap.

---

## Data Snapshot — what's actually in the DB right now (plain terms)

Two different scopes were queried during this investigation — **don't mix them up** when
comparing numbers:

- **Whole-test totals** = all 5 variants combined (Testing Variant, AH, AE, AG, AD, AK), full
  test lifetime (Jun 19 – Jul 22, no date filter).
- **Variant AD only** = just the control variant, scoped to the same window Unbounce's number
  covers (Jun 19 – Jul 22), for a fair apples-to-apples comparison against Unbounce.

### Whole test (all 5 variants combined)

| Term | What it means | Value |
|---|---|---|
| Total events | Every row in `events` for this test (pageviews + conversions) | 1,346 |
| Total pageviews (raw) | Every `type = 'pageview'` row, no dedup — one per page load/reload | 1,246 |
| Unique visitors | Distinct `visitor_hash` values across pageview rows — actual different people | 1,187 |
| Total conversion events (raw) | Every `type = 'conversion'` row fired, including duplicates from Bug 3a | 100 |
| Conversion events matched to a goal | Of the 100, how many got a real `goal_id` attached | 99 (1 orphaned, Bug 5) |
| **Goal Hits** (what the dashboard calls this) | Same as "matched to a goal" above — raw count, inflated ~5x by Bug 3a | 99 |
| **Actual/Real Conversions** (unique people who converted) | Distinct `visitor_hash` among the matched conversion events — this is the number that actually matters | **15** |

In short: 1,187 real people visited across all variants, and only **15 distinct people**
actually converted — even though the raw conversion log shows 100 events, because of the 5x
duplication bug (Bug 3a) plus a bit of genuine repeat-clicking (Bug 3).

### Variant AD only (control), scoped to Jun 19 – Jul 22 — the real comparison vs. Unbounce

| Term | SplitLab | Unbounce | Ratio |
|---|---|---|---|
| Views (raw pageviews) | 255 | 3,700 | ~14.5x lower |
| Unique Visitors | 231 | 2,600 | ~11x lower |
| Actual Conversions (unique people) | 4 | 839 | ~200x lower |
| Goal Hits (raw matched conversion events) | 39 | — (Unbounce doesn't separate this) | ~21x lower |
| CVR | 1.20-1.26% | 32.31% | — |

**Why "Goal Hits" and "Actual Conversions" differ so much within SplitLab itself:** Goal Hits
(39) counts every matched conversion *event*, including the ~5x duplicates from Bug 3a. Actual
Conversions (4) counts distinct *people* — that's the number that should be compared against
Unbounce's "Conversions" metric, since Unbounce also counts real conversions, not raw click
events.

---

## Bug 1 — Dashboard analytics query silently truncates at ~1,000 rows (CONFIRMED, HIGH IMPACT)

**File:** `src/app/api/tests/[id]/analytics/route.ts` (lines 43-51)

```js
let dateFilter = db
  .from('events')
  .select('variant_id, type, goal_id, visitor_hash')
  .eq('test_id', params.id);

if (from) dateFilter = dateFilter.gte('created_at', `${from}T00:00:00Z`);
if (to) dateFilter = dateFilter.lte('created_at', `${to}T23:59:59Z`);

const { data: events } = await dateFilter;
```

**Problem:** No `.range()`, `.limit()`, or `.order()` anywhere on this query. Supabase's
PostgREST layer caps unbounded queries at a default of **1,000 rows** (project setting,
Settings → API → "Max Rows"). This test alone has 1,346 total events — any un-scoped or
wide-date-range dashboard load only ever aggregates whichever ~1,000 rows Postgres happens to
return, silently dropping the rest. No error, no warning.

**Evidence:**
- `select count(*) from events where test_id = '...'` → **1,346** total rows.
- The same unordered/capped-shape query (`select ... limit 1000` with no `order by`) returned
  rows spanning only **2026-07-08 → 2026-07-16** — meaning every dashboard load was blind to
  **the entire most recent week** (Jul 17 onward), every single time, regardless of what date
  range was selected in the UI, because the row cap truncates before the JS-side date filtering
  even matters for anything beyond what got fetched.
- Because there's no `ORDER BY`, which ~1,000 rows come back is not deterministic when there's
  concurrent write load — reproduced by re-loading the dashboard and seeing "945 total views"
  become "929" and "Goal hits for AD: 35" become "30" on repeat loads with no underlying data
  actually changing.

**Fix:** Replace the fetch-all-then-aggregate-in-JS pattern with server-side aggregation —
either a Postgres RPC function using `count(*) filter (...)` / `group by`, or a
`.select(..., { count: 'exact' })`-based paginated loop. RPC is strongly preferred: it avoids
shipping potentially tens of thousands of raw event rows into the Next.js function just to sum
them, which is both more correct and lower overhead than JS-side pagination. Draft RPC:

```sql
create or replace function test_variant_stats(p_test_id uuid, p_from timestamptz, p_to timestamptz)
returns table (variant_id uuid, views bigint, conversions bigint, goal_hits bigint)
language sql stable as $$
  select
    e.variant_id,
    count(*) filter (where e.type = 'pageview') as views,
    count(distinct e.visitor_hash) filter (where e.type = 'conversion' and e.goal_id is not null) as conversions,
    count(*) filter (where e.type = 'conversion' and e.goal_id is not null) as goal_hits
  from events e
  where e.test_id = p_test_id
    and (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at <= p_to)
  group by e.variant_id;
$$;
```

Then `analytics/route.ts` calls `db.rpc('test_variant_stats', {...})` instead of the raw
`select`.

**Implemented (2026-07-22):** migration `037_test_variant_stats_rpc.sql` adds
`test_variant_stats(p_test_id, p_from, p_to)`, returning one aggregated row per variant
(`views`, `unique_visitors`, `conversions`, `goal_hits`) instead of shipping raw event rows into
JS. `analytics/route.ts` now calls this via `db.rpc(...)`. The RPC preserves the existing
goal-membership filter (a conversion only counts if its `goal_id` still belongs to one of the
test's current `conversion_goals`, matching the old `goalIds.has(...)` check, including the
edge case where a test has zero goals defined). **Migration file is written but not yet applied
to the database** — user opted to apply it manually rather than have it run automatically.
The API route will 500 (`rpcError.message`) until the migration is applied.

**Same defect found in the Reporting tab (2026-07-22):** `src/app/api/tests/[id]/reporting/route.ts`
had an identical unbounded `select` on `events` (line 45-54 pre-fix), with no `.range()`,
`.limit()`, or `.order()` — exposed to the same 1,000-row PostgREST cap. Fixed via migration
`038_test_variant_daily_stats_rpc.sql`, adding `test_variant_daily_stats(p_test_id, p_from,
p_to)` which returns one row per **(date, variant)** bucket instead of raw events, keeping the
result set small (days × variants) regardless of event volume. `reporting/route.ts` now calls
this RPC for the chart's daily series, and separately calls `test_variant_stats` (migration 037)
for the summary-card totals — totals intentionally use a whole-range dedup query rather than
summing the daily buckets' `unique_visitors`, since summing per-day uniques would double-count
any visitor who returns on a second day within the selected range. Also fixed: `totals.cvr` and
the daily `_cvr`/`overall_cvr` fields previously divided unique conversions by raw views
(same mismatched-dedup bug as Bug 2); now divide by unique visitors. The existing "Visitors"
summary card was relabeled "Unique Visitors" for clarity (it was already computing the correct
unique-visitor dedup — only the label was ambiguous). **Also not yet applied to the database**
— same manual-apply note as migration 037.

---

## Bug 2 — CVR formula doesn't match Unbounce's (CONFIRMED, LOW IMPACT — ruled out as primary cause)

**File:** `src/app/api/tests/[id]/analytics/route.ts` (line 73)

```js
const cvr = views > 0 ? conversions / views : 0;
```

**Problem:** `views` = raw pageview row count (not deduped to unique visitors). `conversions` =
unique converting visitors. So the formula is really
`unique converting visitors ÷ raw page views`, not Unbounce's
`total conversions ÷ unique visitor sessions`.

**Verified impact:** negligible in practice for this test — raw views (1,246) vs. unique
visitor sessions (1,187) differed by only ~5%. Recomputing CVR with Unbounce's actual formula
moved the number from 1.20% to 1.26% — nowhere near closing the gap to Unbounce's 32-35% range.
**Ruled out as a meaningful contributor to the overall gap**, but still worth fixing for
correctness/consistency with how CVR is presented elsewhere (e.g. client-facing reports).

**Fix:** denominator should be `count(distinct visitor_hash) filter (where type = 'pageview')`,
not raw pageview count.

**Implemented (2026-07-22):** as part of the Bug 1 RPC migration, `cvr` is now
`conversions / uniqueVisitors` (both unique-visitor-deduped) instead of
`conversions / views` (mismatched dedup levels). `confidencePercent()` and `findWinner()` in
`src/lib/stats.ts` now also receive `uniqueVisitors` as the chi-square trial count instead of
raw `views` — each visitor is one Bernoulli trial for significance purposes, not each
pageview/reload. This can shift which variant shows as the reported winner and its confidence
%, since the trial-count denominator changed for every variant. A "Unique Visitors" column was
added to the dashboard table, CSV export, and the header summary tile's CVR calc, alongside the
existing "Views" (raw pageview count) column — both are now shown so raw traffic volume and
unique-visitor volume remain separately visible. The Reporting tab
(`/api/tests/[id]/reporting`) was intentionally left untouched — it already computes its own
independent unique-visitor stat and wasn't part of this fix's scope.

---

## Bug 3 — Click/conversion dedup key too weak, allows multi-click inflation (CONFIRMED, MODERATE IMPACT — inflates, doesn't suppress)

**File:** `src/lib/tracking.ts` (`_SL.track`, dedup logic ~lines 53-64)

```js
track: function(type, goalId) {
  var key = type + ':' + (goalId || '');
  if (this._sent[key]) return;
  this._sent[key] = true;
  this.send(JSON.stringify({ ... }));
}
```

**Problem:** dedup is per-page-load only, keyed on `type:goalId`. A visitor who clicks the same
CTA multiple times *before navigating away* (e.g. double-click, or a slow/broken navigation that
lets them click again) fires multiple conversion rows. `this._sent` also resets on every fresh
page load, so a visitor who reloads/re-visits before converting isn't protected either — though
that's arguably correct behavior for a genuinely repeat visit.

**Evidence:** `select type, count(*), count(*) filter (where goal_id is not null), count(distinct visitor_hash) filter (where goal_id is not null) from events where test_id = '...' group by type` →
100 conversion events, 99 matched to a goal, but only **15 unique converting visitors** — i.e.
matched conversions were fired ~6.6x per converting visitor on average.

**Impact direction:** this **inflates** `goal_hits`, not `conversions` (dashboard already
dedupes `conversions` to unique visitors), and does not explain the views/visitors gap. Real bug,
low urgency relative to Bug 1.

**Note:** an analogous, separate dedup bug exists in `src/app/tracker.js/route.ts` (used only
for Redirect-mode/Proxy-mode destination pages, not HTML-mode pages like Oodles) — dedup key
`type:goalId:trigger:id:text`, same class of issue, different file. Not relevant to this
specific test (HTML-mode/direct passthrough) but worth fixing alongside Bug 3 if that mode is
used elsewhere.

**Update:** the weak dedup key alone doesn't explain the specific `click_count: 5` pattern
observed for nearly every converting visitor (see Bug 3a below) — that pattern needed a second,
independent bug to produce exactly 5 near-simultaneous events per click. Bug 3's dedup weakness
is real and still contributes (it's *why* the 5 duplicate events aren't collapsed back down to 1
before insert), but Bug 3a is the actual root cause of *why* 5 events fire from a single click in
the first place.

---

## Bug 3a — Unscoped goals fetch causes one click to fire N conversion events, one per variant (CONFIRMED, ROOT CAUSE, HIGH IMPACT)

**Files:**
- `src/app/api/serve/route.ts` (lines 453-457) — where goals are fetched per request
- `src/lib/tracking.ts` (`initGoals()`, lines 602, 741-747, and `resolveElements()`, lines 661-715) — where listeners get attached client-side

**Problem:** When `serve/route.ts` builds the tracking snippet for a request, it fetches
conversion goals like this:

```js
// 8. Fetch conversion goals
const { data: goals } = await db
  .from('conversion_goals')
  .select('*')
  .eq('test_id', test.id);
```

This is **not scoped to `selectedVariant.id`** — it fetches every goal row for the whole test,
regardless of which single variant the current visitor is actually being served. This test has
**5 goal rows**, one per variant (AD, AE, AG, AH, AK), and — because the goal was set up once and
propagated to each variant — **all 5 share the exact same selector**:
`text:See If Your Area Is Open →`.

All 5 goal objects get embedded into the tracking snippet and passed into client-side
`_SL.goals`. Then `initGoals()` (`tracking.ts` line 728) does:

```js
_SL.goals.forEach(function(goal) {
  ...
  } else if (goal.type === 'button_click') {
    resolveElements(goal.selector, 'button_click').forEach(function(el) {
      var evt = ...;
      el.addEventListener(evt, function() {
        _SL.track('conversion', goal.id);
      });
    });
  }
});
```

This loops over **all 5 goals** for every page load, no matter which variant is being viewed.
Since all 5 goals share an identical text selector, `resolveElements()` (which matches DOM
elements by visible text — lines 684-698) returns the **same set of matching CTA elements** for
each of the 5 iterations. The net effect: every CTA button on the page ends up with **5 separate
click listeners attached to it — one per variant's goal row — each calling `_SL.track('conversion', <different goal.id>)`**.

Because `_SL.track()`'s dedup key is `type:goalId` (Bug 3), and each of the 5 listeners uses a
**different** `goal.id`, none of the 5 fire-events get deduped against each other. A single real
physical click therefore produces **5 distinct conversion events**, inserted as 5 separate DB
rows, all within milliseconds of each other.

**Evidence:** the per-visitor click breakdown query showed nearly every converting visitor with
`click_count` in exact **multiples of 5** (5, 10, 15), with `first_click`/`last_click` timestamps
sub-second apart (e.g. `1c70d67c...`: 5 clicks in 0.14s; `042aed45...`: 5 clicks in 0.57s;
`09d8958a...`: 10 clicks — likely 2 real physical clicks × 5 duplicate-fired events each). This
is the exact fingerprint of "N goals × 1 real click," not organic human re-clicking.

**Impact:**
- Directly explains why `goal_hits` (99) is ~6.6x higher than unique converting visitors (15) —
  most of that inflation is this bug, not casual repeat-clicking.
- Does **not** directly explain the views/visitors gap (Bug 3a only affects already-converting
  visitors' event *count*, not whether a visitor is counted at all), but it does mean the
  dashboard's `goalHits` column has been structurally unreliable (~5x inflated) for this test
  since goals were created on 2026-07-10.
- Also means every conversion insert since 2026-07-10 has been doing up to 5x the necessary
  writes to `events` for a single real interaction — worth knowing for any future volume/cost
  analysis of the `events` table.

**Fix:** scope the goals query in `serve/route.ts` to the variant actually being served, so only
that variant's own goal (plus any legitimately test-wide `variant_id: null` goals) gets sent to
the client:

```js
const { data: goals } = await db
  .from('conversion_goals')
  .select('*')
  .eq('test_id', test.id)
  .or(`variant_id.is.null,variant_id.eq.${selectedVariant.id}`);
```

This mirrors the scoping already correctly done server-side in `event/route.ts`'s
`matchesGoal()` query (line 110: `.or('variant_id.is.null,variant_id.eq.'+variantId)`) — the
inconsistency is that `serve/route.ts`'s goal fetch (used to build the client-side snippet) was
never scoped the same way. **Not yet implemented — pending.**

---

## Bug 4 — `serve/route.ts` pageview insert has zero dedup (CONFIRMED, BY-DESIGN-ISH, LOW IMPACT)

**File:** `src/app/api/serve/route.ts` (lines 494-503)

```js
// 10c. Record pageview (skip for cap, scan, and Open-button previews)
if (!overVisitorCap && !isScan && !forcedVh) {
  await db.from('events').insert({
    test_id: test.id,
    variant_id: selectedVariant.id,
    visitor_hash: visitorId,
    type: 'pageview',
    metadata: {},
  });
}
```

**Problem:** every request that reaches this line inserts a new pageview row — no per-day or
per-visitor dedup at all, unlike `event/route.ts`'s client-side path (dedup by
visitor+test+day). This means every reload/retry counts as a fresh "view."

**Verified NOT a duplication bug:** initially suspected this double-counted alongside
`tracking.ts`'s own `_SL.track('pageview')` client-side call (line 392 of `tracking.ts`), but
confirmed via a live 2-page-load test (2 opens → exactly 2 DB rows, not 3-4) that this isn't
happening — the client-side pageview POST goes through `event/route.ts`'s dedup check, which
finds the server-side row (already inserted earlier in the same request) and skips inserting a
second one. So in practice, `serve/route.ts`'s insert is the *only* one that actually lands;
`tracking.ts`'s client-side pageview call is effectively dead code for this mode.

**Impact:** this is closer to Unbounce's raw "Views" definition (no dedup) than "Visitors" —
arguably correct/intentional, not really a bug, but worth documenting since it means `views` in
the DB is NOT directly comparable to Unbounce's "Visitors" metric, only loosely to "Views." Low
priority; consider removing the now-dead client-side pageview call in `tracking.ts` for clarity.

---

## Bug 5 — Orphaned conversions with `goal_id = null` are invisible in the dashboard (CONFIRMED, LOW IMPACT — minor)

**File:** `src/app/api/tests/[id]/analytics/route.ts` (line 62), `src/app/api/event/route.ts` (goal-matching logic, lines 102-162)

**Problem:** the dashboard's `conversions`/`goalHits` aggregation strictly requires
`e.type === 'conversion' && e.goal_id !== null`. If a conversion event is inserted but the
goal-matching logic (`matchesGoal()` in `event/route.ts`) fails to find a match, the row is
inserted with `goal_id: null` and becomes permanently invisible in any dashboard aggregate,
even though the raw event exists in `events`.

**Evidence:** of 100 conversion-type events for this test, 99 matched a goal, 1 did not
(`goal_id = null`). Small in this case, but worth a periodic health-check query since a
goal-selector change or a stale visitor session (`FK` violation handling nearby suggests this
happens) could silently orphan a larger share of conversions without any visible error.

**Suggested check query:**
```sql
select count(*) from events
where test_id = '<test_id>' and type = 'conversion' and goal_id is null;
```

---

## Bug 6 — Dashboard date filters use UTC calendar days with no timezone awareness (CONFIRMED, MEDIUM IMPACT — causes real events to appear "missing")

**File:** `src/app/api/tests/[id]/analytics/route.ts` (lines 48-49)

```js
if (from) dateFilter = dateFilter.gte('created_at', `${from}T00:00:00Z`);
if (to) dateFilter = dateFilter.lte('created_at', `${to}T23:59:59Z`);
```

**Problem:** the `from`/`to` date params are interpreted as **UTC calendar days**
(`T00:00:00Z`–`T23:59:59Z`), with no adjustment for the viewer's local timezone. If the person
using the dashboard is in a timezone ahead of UTC, their local "today" starts several hours
*before* UTC's "today" — so real events that happened during their local evening can still be
timestamped as the *previous* UTC day, and won't show up when they filter for "today" by their
own local date.

**Evidence:** reproduced directly — two real pageview events were recorded at `19:05` and
`19:12 UTC` on July 21st. Querying the dashboard/API with `from=2026-07-22&to=2026-07-22` (the
next local calendar day for the user) returned **zero results**, even though the events existed
and were confirmed present via direct SQL for `2026-07-21`. Both the DB and the UI were
technically "correct" per UTC — the mismatch is purely that the user's local "22nd" and the
query's UTC "22nd" don't line up, and the UI gives no indication that dates are UTC-based.

**Impact:** this doesn't lose or corrupt any data (a `from=2026-07-21&to=2026-07-21` query
retrieves the same events fine) — but it makes the dashboard actively misleading for anyone
checking "today's" or "yesterday's" numbers without knowing to think in UTC, especially right
around local midnight. This also affects any comparison against Unbounce, which likely reports
in local/account timezone — meaning a same-day comparison between the two platforms may
silently be comparing two different real-world time windows.

**Fix:** either (a) make the dashboard's date-range picker explicitly show/label that it's using
UTC, or (b) accept a timezone/offset parameter from the client and shift the `T00:00:00Z`/
`T23:59:59Z` boundaries accordingly so "today" matches the viewer's actual local day. Option (b)
is the better user-facing fix but requires plumbing a timezone through the API; option (a) is a
fast, honest stopgap. **Not yet implemented — pending.**

---

## Manual Click-Test — click pipeline confirmed reliable, surfaced a new contamination bug (2026-07-22)

**Why we ran this:** after ruling out a dead CSS/text selector (goal's `selector` matches the
live HTML byte-for-byte, confirmed against the AD variant's actual page source), the remaining
open question was whether `sendBeacon` delivery could be silently failing on real clicks —
unverifiable from the DB alone, since a failed beacon leaves no trace. Needed a live,
reproducible test.

**Method:** 6 manual test runs, each in a fresh browser session, using the `sl_vid` query param
(`src/app/api/serve/route.ts` line 72) to force landing on variant AD specifically:

```
https://start.oodlesofleads.com/oodles?sl_vid=a881ed31-f33f-4a1e-af8a-c312fa78cb2a
```

(`a881ed31-f33f-4a1e-af8a-c312fa78cb2a` = AD's variant UUID, confirmed via the `conversion_goals`
row whose `selector` matches AD's goal.) Each run: load page → note `sl_visitor` cookie value →
click the "See If Your Area Is Open →" CTA → record which CTA location was clicked (hero section,
"One Contractor Per Area" section, or closing "Let's See If Your Area Is Still Available"
section — page has multiple CTAs with identical text).

**Result: 6/6 runs succeeded, 100% reproduction rate.** Every run produced a `pageview` row on
`variant_id = a881ed31-...` (AD) followed by **exactly 5 conversion rows** (one per goal_id,
matching the known Bug 3a mechanism precisely) within ~0.1-0.5s of the click, regardless of which
of the multiple identical-text CTAs was clicked.

**Conclusion: the client-side click → `sendBeacon` → `/api/event` → DB pipeline is reliable.**
Both previously open hypotheses (dead selector, beacon delivery failure) are now **ruled out** —
the code works exactly as designed, every time, for a real click on this exact page.

### New finding: internal/QA traffic is indistinguishable from real conversions (CONFIRMED, MEDIUM IMPACT)

One of the 6 test runs (Test-6) was run non-incognito by mistake, reusing an existing browser
cookie instead of getting a fresh one. That accident surfaced a real bug: the `sl_visitor` cookie
that came back, `09d8958a-5b9a-4329-82f7-df047d868476`, had a prior history that predates this
test entirely:

| When | Variant | Type | Note |
|---|---|---|---|
| 2026-07-10 14:07:59 | `44cb0680...` (not AD) | pageview | |
| 2026-07-10 16:03:21 | `44cb0680...` | pageview | |
| 2026-07-10 16:03:27-28 | `44cb0680...` | conversion ×5 | one real click, Bug 3a fanned to 5 |
| 2026-07-10 16:08:28-29 | `44cb0680...` | conversion ×5 | a second real click, same pattern |
| 2026-07-22 11:02:56 | `a881ed31...` (AD) | pageview | today's Test-6 |
| 2026-07-22 11:06:53 | `a881ed31...` | conversion ×5 | today's Test-6 click |

The July 10th timestamps (14:07-16:08) line up almost exactly with when the `conversion_goals`
rows were created for this test (14:23-14:26 per the goals table) — this is very likely whoever
built/QA'd the goals that day, browsing the live page non-incognito. This is the same
`09d8958a...` visitor already flagged in Bug 3a's evidence above as having "10 clicks... likely 2
real physical clicks × 5 duplicate-fired events each" — meaning **this non-customer cookie was
already counted as one of the whole-test's "15 unique converting visitors"** in the original data
snapshot, before this investigation ever started.

**Problem:** `events` has no `is_preview` / `is_test` / internal-traffic flag of any kind. Every
write — including a team member idly reloading the live page to check it looks right, or the
`sl_vid`-forced QA runs done for *this investigation itself* — lands in the exact same table as
real customer visits, completely indistinguishable in any query. Given how small the real
conversion counts are for this test (4-15 unique converters total across all analysis), even one
persistent non-incognito team cookie meaningfully inflates the numbers everyone has been trying to
reconcile against Unbounce.

**Immediate consequence:** this investigation's own 6 test runs today added 6 real pageviews +
30 real conversion events to variant AD's live numbers. Any future comparison query must exclude
these hashes or it will show inflated results:

```sql
and visitor_hash not in (
  '695ed276-9a7e-4600-aa48-b6a93b342a5a',
  '2ddcf79f-100a-4d43-9bbb-c156f6daec1d',
  '86e75fa8-06e6-473d-b2b2-0eaaccb6dccd',
  '20e10b3e-065c-4bb2-803f-729a508b9ae3',
  '2b784745-bd42-4caa-8717-b274783cbfd0',
  '09d8958a-5b9a-4329-82f7-df047d868476'
)
```

**Fix (not yet implemented):** tag events originating from `sl_vid`-forced requests (these are
by definition QA/preview, never real traffic — `serve/route.ts` already knows `forcedVid` is set)
with an `is_preview` flag, and give team members a way to explicitly mark a browser session as
internal (e.g. a `sl_internal` cookie set from an authenticated dashboard session) so casual
non-incognito checks don't silently pollute client-facing analytics. Dashboard aggregates should
default to excluding flagged rows.

---

## Bug 8 — Cross-domain conversion mints a phantom "new visitor" for every real click-through (CONFIRMED, HIGH IMPACT — inflates visitors in lockstep with conversions)

**Discovery:** while re-running the manual click tests (Bug 3a verification above), `unique_visitors`
and `unique_conversions` were observed incrementing **together** on a single click — not just the
expected conversion increment. Isolated with a clean single-load-then-click test (no back-navigation
involved): loading the page correctly added 1 unique visitor; the click *by itself* then added
**both** another unique visitor *and* the expected unique conversion.

**Root-caused via Vercel request logs.** Immediately after a click's 5 conversion `POST /api/event`
calls, the logs show:

```
11:40:28  GET  www.trysplitlab.com/api/resolve?vid=a881ed31-f33f-4a1e-af8a-c312fa78cb2a
11:40:29  POST www.trysplitlab.com/api/event
11:40:31  POST www.trysplitlab.com/api/register-form-fields  ×2
```

The `/api/resolve` call is `tracker.js` (`src/app/tracker.js/route.ts`) running on the **destination**
page, `oodlesofleads.com/booking` — cross-domain attribution tracking is installed and firing there.
The `POST /api/event` two seconds later is `tracker.js`'s own unconditional pageview call
(`boot()`/`start()`, fires `track("pageview")` on every load regardless of whether the test has any
`url_reached` goal configured — confirmed by reading the code, `track()` only checks for an existing
`_ctx` and a dedup key, nothing about goals). That pageview landed in the `events` table under a
**brand-new `visitor_hash`**, against the **same `test_id`/`variant_id`** as the original page —
i.e. one real person, one real click, now counted as 2 distinct "unique visitors."

**Why the identity isn't preserved across the domain hop:** `decorate()` (`src/lib/tracking.ts`,
line ~250) is supposed to tag any outbound cross-domain link with three params together —
`sl_tid`, `sl_vid`, `sl_vh` — specifically so the destination's `tracker.js` can pick up `sl_vh`
and continue tracking as the *same* visitor (`detect()`'s "Method 1"). But `tracker.js` has a
fallback ("Method 2"): if the URL carries `sl_vid` alone, without `sl_tid`/`sl_vh`, it does
`var tempVh = vh || uuid();` — mints a fresh identity instead of reusing anything.

**Confirmed live which path fires:** captured the actual destination URL after clicking:

```
Entry:       https://start.oodlesofleads.com/oodles?sl_vid=a881ed31-f33f-4a1e-af8a-c312fa78cb2a
Destination: https://oodlesofleads.com/booking?sl_vid=a881ed31-f33f-4a1e-af8a-c312fa78cb2a
```

Only `sl_vid` made it across — `sl_tid` and `sl_vh` are both missing. This is exactly Method 2's
trigger condition, so the fresh-UUID fallback is confirmed as the mechanism.

**Open sub-question — why `decorate()` didn't add all three:** the CTA's raw HTML has no query
params at all (`<a href="https://oodlesofleads.com/booking">`), and `decorate()` never has a code
path that adds `sl_vid` without also adding `sl_tid`/`sl_vh` in the same pass — so either (a) the
`mousedown`/`click`-triggered href mutation silently failed to apply for this button, or (b)
`oodlesofleads.com`'s own page JS rebuilds/overwrites the href at click time (common with
funnel-builder click handlers), replacing SplitLab's decoration — and `sl_vid` only survived
because the destination page separately carries the referring page's query string forward on its
own (`sl_vid` happened to already be in the SplitLab dashboard's `sl_vid=`-forced test URL, which
is unrelated to `decorate()`). Not yet isolated which of the two it is — next step is inspecting
the CTA's live `href` attribute immediately after a `mousedown` (before navigation completes) to
see whether `decorate()` ran at all.

**Impact:** this fires on every real click-through that lands the visitor on a page with
`tracker.js` installed, not just test runs — meaning it's a plausible, ongoing, silent contributor
to `unique_visitors` inflation that scales precisely with real conversion volume (the more people
actually convert, the more phantom visitors get added), independent of the QA-contamination issue
documented above. **Not yet fixed.**

**Fix direction (not yet implemented):** determine and fix why `decorate()`'s href mutation isn't
reliably landing before navigation for this CTA (or add a safeguard against destination-page JS
stomping the decorated href), so `sl_tid`+`sl_vh` reliably accompany `sl_vid` cross-domain and
`tracker.js`'s Method 1 (identity reuse) fires instead of Method 2 (fresh mint).

---

## Bug 1/2 Fix Verification — dev synthetic-load test (2026-07-22)

**Why:** correctness of the RPC's aggregation math doesn't require >1,000 rows, but proving the
row-cap fix itself does — dev traffic for any single test rarely reaches that volume naturally.

**Method:** ran `docs/synthetic-events-test.sql` against dev test `d893ddb6-9eec-4bd9-b973-
54e69cbd5204`, inserting ~1,600 synthetic `pageview` rows + ~130 synthetic `conversion` rows
(all `visitor_hash` prefixed `synthetic-` for easy identification/cleanup) directly onto that
test's existing variant, on top of its small pre-existing real baseline (3 pageviews, 1
conversion with a real `goal_id`).

**Result — the row cap is real and severe:**

| Query | Views | Unique Visitors | Conversions |
|---|---|---|---|
| Ground truth (uncapped, `goal_id is not null` scoped) | 1,603 | 1,603 | 1 |
| Simulated old behavior (`limit 1000`, no `order by`) | 976 | 976 | — |
| `test_variant_stats()` RPC (the fix) | 1,603 | 1,603 | 1 |

The capped simulation undercounted views by **39%** (976 vs 1,603) — a direct, reproduced
confirmation that Bug 1 silently truncates real data, not just a theoretical risk. The RPC
matches ground truth exactly. (Note: the synthetic conversions were inserted without a
`goal_id`, so they're correctly excluded from both the ground-truth and RPC conversion counts —
only the 1 real conversion, which has a real `goal_id`, counts. This was confirmed by checking
`conversion_goals` for the test and re-running the ground-truth query with the same
`goal_id is not null` filter the RPC applies, which resolved an initial apples-to-oranges
mismatch during testing.)

**Cleanup query (reusable for future dev verification runs):**
```sql
delete from events
where test_id = '<test_id>'
  and visitor_hash like 'synthetic-%';
```
Scoped to both `test_id` and the `synthetic-` prefix, so it only ever removes rows this kind of
test run added — real data for the test (and everything else in the database) is untouched. Kept
in `docs/synthetic-events-test.sql` for reuse on future migrations/verifications.

---

## Still Open — the real 11-14x traffic gap (NOT YET EXPLAINED)

None of Bugs 1-5 account for the scoped, apples-to-apples gap for Variant AD
(Jun 19 – Jul 22): Unbounce 2,600 visitors / 3,700 views / 839 conversions vs. SplitLab's 231
unique visitors / 255 views / 4 conversions (39 goal hits). Bug 1 (row-cap truncation) explains
why the *dashboard UI* showed even lower numbers than the true DB totals, but the true DB totals
themselves are still ~11-14x below Unbounce.

**Leading hypothesis, not yet confirmed:** not all real traffic to the page is being routed
through SplitLab's serving pipeline (middleware → `/api/serve` → variant assignment) at all —
e.g. some ad/campaign traffic may point at a different domain/URL that Unbounce tracks
natively but that never resolves through `start.oodlesofleads.com`, or partial DNS/CDN
propagation means some visitors hit a cached/original version of the page that never touches
SplitLab's middleware.

**Next steps:**
1. Confirm with the client/media buyer exactly which URL(s) ad campaigns and other traffic
   sources point to — verify `start.oodlesofleads.com/oodles` is the *only* live destination.
2. Verify DNS/CDN cutover is fully consistent (no partial resolution to a non-SplitLab origin).
3. Once traffic routing is confirmed clean, re-run the same scoped SQL comparison for a fresh,
   short, verifiable window to re-check the gap.

---

## Query reference (for re-verification later)

Total events for a test:
```sql
select count(*) from events where test_id = '<test_id>';
```

Views/conversions split by type:
```sql
select
  type,
  count(*) as total,
  count(*) filter (where goal_id is not null) as with_goal_id,
  count(distinct visitor_hash) filter (where goal_id is not null) as unique_visitors_with_goal
from events
where test_id = '<test_id>'
group by type;
```

Per-variant, date-scoped comparison (the correct apples-to-apples query):
```sql
select
  count(*) filter (where type = 'pageview') as views,
  count(distinct visitor_hash) filter (where type = 'pageview') as unique_visitors,
  count(distinct visitor_hash) filter (where type = 'conversion' and goal_id is not null) as conversions,
  count(*) filter (where type = 'conversion' and goal_id is not null) as goal_hits
from events
where test_id = '<test_id>'
  and variant_id = '<variant_id>'
  and created_at >= '<from>T00:00:00Z'
  and created_at <= '<to>T23:59:59Z';
```
