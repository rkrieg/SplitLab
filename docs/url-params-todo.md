# URL Params / UTM Passthrough — Todos

**Status:** ✅ **All four todos implemented** (2026-07-20). `npm run build` passes.
**Written:** 2026-07-20

| Todo | Code | Verification |
|---|---|---|
| **Todo 1** — forward params through redirect + proxy | ✅ Done | ✅ Verified live against active rigs — redirect `Location` carried 13/13 + `sl_vid`/`sl_vh` once each, no `domain`/`path`/`preview_test_id` leaked; proxy iframe `src` likewise |
| **Todo 2** — remember params for the visit | ✅ Done | ✅ Logic verified — real shipped `tracker.js` run in a stubbed DOM, 17/17 (page-2 non-wipe, last-touch, PII exclusion, expiry, blocked storage, `sl_tracking` untouched). Browser matrix still pending |
| **Todo 3** — arbitrary params + `extra_params` | ✅ Done | ⚠️ **Migration 035 not yet applied to any database.** End-to-end untested |
| **Todo 4** — cross-domain forwarding | ✅ Done | ⏳ Needs the browser matrix below |

> ### ⚠️ Deploy order — the one way this loses data
>
> **Apply `035_form_leads_extra_params.sql` BEFORE deploying the code.** If the code ships first, every `form_leads` insert fails with `500 Failed to save lead`, and because `sendBeacon` is fire-and-forget with no retry, **the lead is gone** — not queued, not recoverable.
>
> The reverse order is inert and safe: a column nobody writes to yet does nothing. **Safe for staging**, which shares this database — `NOT NULL DEFAULT '{}'` means staging's existing inserts (which never mention the column) keep succeeding, and its `select('*')` just returns one extra key that nothing iterates over.

**Amended:** 2026-07-20 — coverage audit against the code. Added: navigation-type verification (no gaps found, plus one documented won't-fix), the Todo 3 + Todo 4 hidden-input capture loop, the Todo 4 `_ctx` decoupling, the deny-list/allowlist rationale, the GA cross-domain trade-off, and a full **Test plan** + **Regression suite**.

**Implemented:** 2026-07-20 — all four todos. Branch `fix-utm-params`.

**Branch context:** Related to but **not blocked by** `url-conversion-v2` (see [url-conversion-v2-plan.md](./url-conversion-v2-plan.md)).

> **Note on the sections below.** Everything from *The complaint* onward is written in the present tense describing the **pre-fix** behaviour — "we drop the params", "a fixed 7-name allowlist". That is deliberate: it records why each change exists. Read it as the problem statement, not current state. The status table above is the current state.

---

## The complaint (client, verbatim)

> "One of the clients was complaining that our traffic wasn't converting. Lo and behold, it's because one of the pages was getting the UTMs, but it wasn't passing them to the next page.
>
> We need to make sure that, for example, if the form accepts the UTMs, it passes it through the form. If it clicks out to another page, it still passes those same UTMs to any subsequent pages."

Marked **"Extremely important."**

The traffic *did* convert. The attribution was blank, so it looked like it didn't.

## Example inbound URL (Facebook ads)

```
?fbc_id={{adset.id}}&h_ad_id={{ad.id}}&utm_source=paidsocial&utm_medium={{adset.name}}
&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&hsa_acc=999368881986267
&hsa_cam=120240244340500249&hsa_grp=120247816737200249&hsa_ad=120247816737210249
&hsa_src=[SITE_SOURCE_NAME]&hsa_net=facebook&hsa_ver=3
```

Of these 13 params we currently store **4** (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`).

Dropped: `fbc_id`, `h_ad_id`, `hsa_acc`, `hsa_cam`, `hsa_grp`, `hsa_ad`, `hsa_src`, `hsa_net`, `hsa_ver`.

> **`fbc_id` is not `fbclid`.** We support `fbclid`; this URL carries `fbc_id`. Different param. Reads as supported at a glance, isn't. Both must be kept — whatever the URL actually has.
>
> The `hsa_*` params are the machine-readable ad / adset / campaign IDs. The `utm_*` ones are human labels. **We keep the labels and throw away the keys** — so leads can't be joined back to ad spend for real cost-per-lead.

---

## The four breakage points

A tracking param must survive four jumps to reach a lead row. We break three of them, for three unrelated reasons.

```
Facebook ad
   │  jump 1: our 302 / proxy         ← BROKEN (Todo 1) — server-side, we delete them
landing page 1
   │  jump 2: click to page 2 (same site)  ← BROKEN (Todo 2) — we only read the live URL
page 2
   │  jump 3: click out to another domain  ← BROKEN (Todo 4) — decorate() carries only sl_*
page 3
   │  jump 4: form submit → DB        ← PARTIAL (Todo 3) — 7-name allowlist
form_leads row
```

---

# Coverage matrix — which todo fixes which case

Verified against the code 2026-07-20. **"Now"** = current behaviour, **"After"** = which todo fixes it.

### Jump 1 — visitor arrives from the ad

| Mode | Now | After |
|---|---|---|
| **HTML** | ✅ **already works.** No redirect — the browser URL stays `clientdomain.com/path?utm_...`, and the injected snippet reads it directly. | unchanged |
| **Redirect** | ❌ params dropped — [`serve/route.ts:284`](../src/app/api/serve/route.ts#L284) builds the URL fresh from `redirect_url` | **Todo 1** |
| **Proxy** | ❌ params dropped — [`serve/route.ts:234`](../src/app/api/serve/route.ts#L234) builds the iframe `src` fresh | **Todo 1** |

### Jumps 2-4 — navigating and submitting

| Case | HTML | Redirect | Proxy |
|---|---|---|---|
| Same-domain link/click, page 1 → page 2 | Todo 2 | Todo 2 | Todo 2 ⚠️ |
| Same-domain `location.href` | Todo 2 | Todo 2 | Todo 2 ⚠️ |
| Cross-domain link / form / `window.open` | Todo 4 — **100% of browsers** | Todo 4 — 100% | Todo 4 — 100% |
| Cross-domain `location.href` | Todo 4 — **87%** | Todo 4 — 87% | Todo 4 — 87% |
| Form submit → DB | Todo 3 | Todo 3 | Todo 3 |

Same-domain needs no interception at all — the params are already in that origin's storage, so Todo 2 covers it on **every browser**. The 87% Navigation-API ceiling applies **only** to cross-domain `location.href` (`watchNavigations`, [`tracker.js:224`](../src/app/tracker.js/route.ts#L224) / [`tracking.ts:213`](../src/lib/tracking.ts#L213)). Links, forms and `window.open` are patched directly and are unaffected by it.

### Navigation-type coverage — verified 2026-07-20, no gaps

Checked against the actual event bindings, [`tracker.js:991-994`](../src/app/tracker.js/route.ts#L991-L994) and [`tracking.ts:248-250`](../src/lib/tracking.ts#L248-L250):

```js
document.addEventListener("mousedown", decorateFromEvent, true);
document.addEventListener("auxclick",  decorateFromEvent, true);
document.addEventListener("click",     …, true);
```

| Activation | Fires | Covered by |
|---|---|---|
| Left-click a link | `mousedown` → `click` | link decoration |
| Middle-click / ctrl+click (new tab) | `mousedown` → `auxclick` | link decoration |
| **Keyboard Enter on a focused link** | `click` **only** — no `mousedown` | the third listener |
| `window.open(...)` | — | `patchWindowOpen` |
| `<form>` submit (GET and POST) | — | `decorateFormForSubmit` |
| `location.href` / `.assign()` / `.replace()` | navigate event | `watchNavigations` (87%) |

**The keyboard case is the one worth knowing about.** Enter-activation of a link never fires `mousedown`, so a mousedown-only binding would silently drop every keyboard and most assistive-tech navigation. The `click` listener closes it. **Do not "simplify" these three listeners into one during any todo below** — each covers a case the others miss.

**Not covered by anything, and deliberately won't be:** `<meta http-equiv="refresh">` and a server-issued 302 from the client's own page. Both bypass links, forms, `window.open` and the Navigation API alike — no script hook exists. Rare on landing pages. Logged here so it's a documented won't-fix rather than an unnoticed blank.

### ⚠️ Proxy mode: Todo 1 is a hard prerequisite, not an optimisation

Proxy mode runs **two trackers in two different origins**:

```
top frame   = clientdomain.com   → tracking.ts   → HAS the visitor's params
  └─ iframe = destination.com    → tracker.js    → src is built fresh: sl_vid + sl_vh ONLY
```

The visitor's form is **inside the iframe**, so lead capture happens in the iframe's origin. Three consequences:

1. **`localStorage` cannot cross that boundary**, so Todo 2 storing params in the top frame does **nothing** for the iframe. Todo 2 alone cannot fix proxy mode.
2. **Todo 1 is the only way params reach the iframe at all.** Without it, every proxy lead is attributed to nothing, regardless of what Todos 2/3/4 do.
3. Once Todo 1 lands, the iframe URL carries the params, so Todo 2 then works normally *within* the iframe origin for subsequent same-domain pages.

**Sequencing consequence: for proxy mode, Todo 1 must ship before Todo 2 is worth anything.** This is the one place the recommended 2 → 1 order is wrong; if the affected client is on proxy mode, do Todo 1 first.

**Storage inside the iframe is verified, not assumed.** Re-checked 2026-07-20 against url-conversion-v2-plan.md Priority 0 (dated 2026-07-16, marked confirmed):

> "Repeat the whole test in **Safari** — this is the fragile one (ITP may block third-party-iframe `localStorage`). **✅ PASSED — conversion fired. Safari ITP did NOT block the iframe's localStorage.**"

That test covered **same-domain navigation inside the iframe** — precisely the case Todo 2 depends on, not an adjacent result being extrapolated. Chrome ✅ and Safari ✅. The iframe is sandboxed `allow-same-origin allow-scripts` ([`serve/route.ts:250`](../src/app/api/serve/route.ts#L250)), which is what preserves storage access. **Todo 2 works inside the proxy iframe once Todo 1 has put the params there.**

### Rejected alternative: decorate same-domain URLs instead of using storage

Considered — pass params in the URL on same-domain navigation too, so proxy needs no storage. **Rejected on two grounds:**

1. **It cannot fix proxy jump 1 anyway.** The iframe `src` is built server-side and the params are absent from it, so the tracker inside the iframe has nothing to read or propagate. No client-side technique recovers data that never crossed the boundary. Todo 1 is the only lever. (The top frame could rewrite `iframe.src` from JS, but that forces a second full load of the client's site and is strictly worse than building the URL correctly server-side.)
2. **It would break the client's own Google Analytics.** GA treats a UTM-tagged pageview as the start of a **new campaign session**. Decorating internal links makes every page-2 view a fresh session, re-attributed to the campaign — inflating session counts, collapsing bounce rate, and corrupting the client's funnel reports. Fixing our attribution by breaking theirs is a bad trade, especially when the originating complaint was about untrustworthy conversion numbers.

Storage avoids both: invisible to GA, no URL pollution, no interference with client routing or SEO canonicals. **Use URL-passing only where storage physically cannot reach — i.e. cross-origin (Todo 4).**

---

# ✅ Todo 1 — Forward inbound params through redirect + proxy modes — DONE

**Priority: high. Confirmed bug, server-side, affects 100% of redirect/proxy pageviews in every browser.**

### The problem

[`src/app/api/serve/route.ts:284-286`](../src/app/api/serve/route.ts#L284-L286) (redirect mode):

```ts
const redirectUrl = new URL(selectedVariant.redirect_url);
redirectUrl.searchParams.set('sl_vid', selectedVariant.id);
redirectUrl.searchParams.set('sl_vh', visitorId);
```

And [`L234-236`](../src/app/api/serve/route.ts#L234-L236) (proxy mode, identical shape).

The URL is built **fresh from `redirect_url`**. The visitor's inbound query string is never merged in. **SplitLab itself is the thing stripping the UTMs** — the exact bug the client hit on Unbounce, reproduced by us server-side.

### Verified: the params DO reach this code

[`src/middleware.ts:63-68`](../src/middleware.ts#L63-L68):

```ts
const url = request.nextUrl.clone();   // ← clone() preserves the original query string
url.pathname = '/api/serve';
url.searchParams.set('domain', host);
url.searchParams.set('path', pathname);
return NextResponse.rewrite(url);
```

`nextUrl.clone()` keeps the full inbound query. `domain` and `path` are *added* alongside. **Confirmed — the fix belongs in `serve/route.ts`, not in the middleware.**

### The fix

Merge inbound params into both destination URLs, with a deny-list of our own control params.

**Must NOT forward** (these are ours, or middleware's, and forwarding them causes real bugs):

| Param | Why it must be excluded |
|---|---|
| `domain`, `path` | Injected by middleware. Meaningless downstream, leaks internals. |
| `sl_vid`, `sl_vh` | We set these ourselves two lines later. Forwarding first would double-set, and [`serve/route.ts:17-18`](../src/app/api/serve/route.ts#L17-L18) reads `sl_vid` as `forcedVid` — a forwarded value could pin the wrong variant. |
| `sl_scan` | Already handled explicitly by `isScan`. |
| `preview_test_id` | Dashboard-only, read at [`L21`](../src/app/api/serve/route.ts#L21). Must not escape to a client destination. |
| `sl_tid` | Not read by serve today, but reserved. Exclude for symmetry with `decorate()`. |

**Precedence rule:** if `redirect_url` already contains a param the visitor also has, **the saved `redirect_url` wins**. The client configured it deliberately; a visitor-supplied param must not be able to override it. Implement as "only set if not already present."

**Cap the forward** at ~30 params and ~2000 chars total to prevent a crafted URL from producing an over-long `Location` header.

### Deny-list here, allowlist in Todos 2/3 — deliberate, don't "fix" it

Todo 1 forwards **everything except** a deny-list. Todos 2 and 3 store **only** an allowlist. The asymmetry is intentional, and the reasoning must survive future edits:

- **Forwarding** is liberal because the destination is the client's own page. A param we don't recognise may still be one their page needs — dropping it recreates the exact bug we're fixing, one layer down.
- **Storing** is conservative because the destination is our production database. A blanket capture would sweep in `email=`, `session=`, `order_id=` — PII and session tokens in an analytics table we then export to CSV and push to HubSpot.

**Consequence to expect, not to debug:** a param can legitimately appear in the destination address bar and *never* reach the lead row. That is correct behaviour. If someone later "aligns the two lists," they will either start dropping client params at the redirect or start storing PII — check which direction before accepting such a change.

### Break-risk check

- **HTML variants:** unaffected — this code path only runs when `selectedVariant.redirect_url` is set.
- **Existing `sl_*` flow:** unaffected, the deny-list guarantees our params are still set exactly once by the existing lines.
- **Sticky assignment / cookies:** unaffected, assignment happens before this block.
- **`url-conversion-v2`:** unaffected. `decorate()` runs client-side on the destination; this only changes the URL the visitor arrives at. The `sl_vid`/`sl_tid` early-return in `decorate()` is untouched.
- **`cleanUrl()` will not eat the forwarded params — verified 2026-07-20.** [`tracker.js:136`](../src/app/tracker.js/route.ts#L136) deletes only the keys it is handed, and the sole call site ([`L1150`](../src/app/tracker.js/route.ts#L1150)) passes `["sl_tid","sl_vid","sl_vh","sl_scan"]`. UTMs survive in the address bar on the destination, which is what Todo 2 then reads. **There is no ordering bug between Todo 1 and Todo 2.** If anyone ever adds tracking params to that array, Todo 2 breaks silently on the redirect/proxy path — the params would be stripped before storage.
- **Open question — proxy mode:** the forwarded params go on the **iframe src**. Confirm this doesn't change how the destination behaves inside the frame. Low risk (they're the params it would have received anyway), but worth one manual check against test rig `609c84aa-a5b8-4cc5-9c5f-70a0ea69103c`.

### Verify after

Redirect rig `579167ba-88c9-451d-966d-a8b5ab5ca821` — hit the raw test URL with the full Facebook string above in incognito, confirm the destination address bar carries all 13 params plus `sl_vid`/`sl_vh`.

---

# ✅ Todo 2 — Remember params for the visit, don't re-read the address bar — DONE

**Priority: highest value. Fixes the client's literal complaint ("page 1 got them, page 2 didn't"). Small change.**

### The problem

Capture reads the live URL **at submit time only**. Three identical copies:

- [`tracker.js:797-801`](../src/app/tracker.js/route.ts#L797-L801)
- [`tracker.js:837-841`](../src/app/tracker.js/route.ts#L837-L841)
- [`tracking.ts:323-327`](../src/lib/tracking.ts#L323-L327)

```js
var sp = new URLSearchParams(window.location.search);
```

If the ad lands on page 1 and the form is on page 2, page 2's address bar is clean → the lead saves with null UTMs.

**This fails selectively**, which is why it reads as "some pages work, this one doesn't": single-page funnels look perfect, multi-page funnels lose everything.

### The fix

On **every** page load, if the URL carries any tracking params, write them to `localStorage` under a new key. At submit time, read from storage, not from the URL.

- **New key: `sl_params`.** Do **not** reuse `sl_tracking` ([`tracker.js:46`](../src/app/tracker.js/route.ts#L46)) or `sl_ctx` ([`tracking.ts:76`](../src/lib/tracking.ts#L76)) — those hold variant assignment and are read by the Method 1-4 detection chain. Polluting them risks the whole boot path.
- **Never write an empty set.** Only overwrite when the current URL actually has ≥1 tracking param, otherwise page 2 wipes page 1's data — which is the exact bug being fixed. This is not an attribution choice, it is the fix itself.
- **First-touch vs last-touch — decided: last touch.** This only matters when one visitor arrives twice from two different ads (clicks a Facebook ad Monday, leaves, clicks a Google ad Thursday, converts). Last touch credits Google; first touch credits Facebook. Last touch chosen because it is the default in both Google Ads and Meta Ads — so our dashboard agrees with the client's ad platform instead of quietly disagreeing — and because it matches the existing `sl_ref` affiliate cookie precedent in [`middleware.ts:106`](../src/middleware.ts#L106).
  - Implementation: a new inbound URL carrying ≥1 tracking param **replaces the whole stored set**. Do not merge param-by-param across visits — mixing Monday's `hsa_ad` with Thursday's `utm_campaign` produces a row describing an ad that never existed.
  - Most visitors arrive once, so both rules agree for the large majority of leads. Revisit only if Renny asks for first-touch.
- **Expiry:** stamp with a timestamp, treat as stale after 90 days (matches the `sl_visitor` cookie lifetime).
- Wrap in `try/catch` like the existing `saveMap`/`loadMap` at [`tracker.js:83`](../src/app/tracker.js/route.ts#L83) — blocked storage must stay harmless.

### Break-risk check

- **Storage is per-origin.** This does **not** carry params across a domain boundary — that's Todo 4's job. Documented so nobody assumes Todo 2 makes Todo 4 redundant. It doesn't.
- **Both files must change together.** `tracker.js` and `tracking.ts` are parallel implementations (external tracker vs injected snippet). Fixing one only fixes some modes.
- **Precedence at submit:** live URL params should win over stored ones when both exist. Same-page is more specific than remembered.
- **No effect on conversion events or statistics** — this only touches the form-lead payload, which is a separate pipeline from `/api/event`.
- **Privacy:** the stored set must be limited to the tracking-param allowlist/prefixes from Todo 3. Do not blanket-store the whole query string — client URLs can contain emails, session tokens, or PII.

### Verify after

Two-page funnel: land on page 1 with the Facebook string, click through to page 2 (no params), submit the form there. Lead row must carry the full param set. Dashboard is the only real confirmation — `sendBeacon` is fire-and-forget.

---

# ✅ Todo 3 — Store and display arbitrary tracking params — DONE (migration not yet applied)

**Priority: medium. Biggest of the four, only one that touches the schema.**

### The problem

A fixed 7-name allowlist, duplicated in three places (`tracker.js:799`, `tracker.js:839`, `tracking.ts:325`):

```js
["utm_source","utm_medium","utm_content","utm_term","utm_campaign","gclid","fbclid"]
```

Everything else is discarded before it ever leaves the browser.

### Capture rule (replaces the fixed list)

Keep a param if **any** of:

1. Name starts with `utm_`
2. Name starts with `hsa_`
3. Name is a known click ID: `gclid`, `fbclid`, `fbc_id`, `fbp`, `msclkid`, `ttclid`, `li_fat_id`, `twclid`, `dclid`, `wbraid`, `gbraid`, `epik`, `sccid`, `irclickid`
4. Name matches `_id$` **and** is in an explicit extras list (`h_ad_id`, `ad_id`, `adset_id`, `campaign_id`, `creative_id`, `placement_id`)

**Never capture** anything starting with `sl_` — those are ours and would confuse the detection chain if echoed back.

**Limits:** max 40 params, key ≤ 100 chars, value ≤ 500 chars, total serialized ≤ 8KB. Server re-applies these — never trust the client payload.

> **Rule 4 is deliberately not a bare `_id$` regex.** A blanket suffix match would sweep up `user_id`, `session_id`, `order_id` — session identifiers and PII that must not land in an analytics table. Keep it an explicit list.

### Schema — **additive only**

**Hard constraint from the client: `form_leads` is in production. Do not drop, rename, or retype any existing column.** `utm_source`, `utm_medium`, `utm_content`, `utm_term`, `utm_campaign`, `gclid`, `fbclid` all stay exactly as they are and keep being populated exactly as they are.

New migration `035_form_leads_extra_params.sql`:

```sql
ALTER TABLE form_leads ADD COLUMN extra_params jsonb NOT NULL DEFAULT '{}';
```

One additive column. Nothing else.

**Dual-write rule:** the 7 existing columns remain the source of truth for those 7 names. `extra_params` holds **only** the params that have no dedicated column. Do not duplicate `utm_source` into both — every existing reader keeps working untouched, and there's no chance of the two disagreeing.

> **Do NOT put these in `form_fields`.** Tempting, because [`form-leads/route.ts:64-68`](../src/app/api/tests/[id]/form-leads/route.ts#L64-L68) already derives dynamic table columns from `form_fields` keys, so they'd appear in the UI for free. It would break two things:
> 1. [`form-field-keys/route.ts`](../src/app/api/tests/[id]/form-field-keys/route.ts) falls back to `form_fields` keys to populate the **HubSpot / webhook field-mapping dropdown**. Ad params would pollute the list of "form fields the client can map."
> 2. `form_fields` means "what the visitor typed." Mixing in URL params corrupts that meaning permanently, in a production table.

### Downstream changes required

| Location | Change |
|---|---|
| [`api/form-leads/route.ts:60-74`](../src/app/api/form-leads/route.ts#L60-L74) | Insert `extra_params`. Re-apply caps server-side. |
| [`api/form-leads/route.ts:113-123`](../src/app/api/form-leads/route.ts#L113-L123) | Add `extraParams` to `DispatchParams.systemData`. |
| [`api/tests/[id]/form-leads/route.ts:64-68`](../src/app/api/tests/[id]/form-leads/route.ts#L64-L68) | Return a **separate** `extraParamKeys` array. Keep `fieldKeys` meaning form fields only. |
| `AnalyticsClient.tsx:130` (`FormLead` interface) | Add `extra_params: Record<string,string> \| null`. |
| `AnalyticsClient.tsx:1759` (`exportFormLeadsCsv`) | `fixedCols` is hardcoded — append the extra-param columns. |
| `AnalyticsClient.tsx:3483` | Table shows **only `utm_source`** today. **Decided: add columns to the table** — one per captured param, same as the existing dynamic form-field columns. No detail drawer. |
| [`integrations/hubspot.ts:39-45`](../src/lib/integrations/hubspot.ts#L39-L45) | `SYSTEM_FIELDS` list — optionally expose extras for mapping. |
| [`integrations/webhook.ts:18-30`](../src/lib/integrations/webhook.ts#L18-L30) | `SYSTEM_FIELD_KEYS` — same. Note it currently omits `gclid`/`fbclid` even though HubSpot has them; **pre-existing inconsistency**, worth fixing here. |

### Break-risk check

- **Existing leads:** `DEFAULT '{}'` means every historical row reads back as an empty object. No backfill, no migration downtime.
- **Existing integrations:** untouched. They read the 7 named columns, which keep their exact current behaviour. Extras are opt-in per mapping.
- **CSV export:** column count grows. Confirm nothing downstream assumes a fixed header.
- **Table width:** the leads table is already wide with dynamic form-field columns, and ~10 ad params will make it considerably wider. **Decision made: add the columns.** Ensure the table container scrolls horizontally rather than letting the page body scroll — the existing dynamic form-field columns already establish this pattern, follow it.

### Also worth fixing in this pass

**Hidden inputs are skipped at [`tracker.js:792`](../src/app/tracker.js/route.ts#L792) and [`L773`](../src/app/tracker.js/route.ts#L773).** The standard Unbounce / landing-page pattern for UTM passthrough is hidden fields populated from the query string — **so if the client already solved this themselves, we deliberately discard their solution.**

Do **not** simply stop skipping hidden fields — hidden inputs also carry CSRF tokens, session IDs, and internal state. Instead: read hidden inputs *only* when the name matches the Todo 3 tracking-param rules, and route them to `extra_params`, never to `form_fields`.

> Note the interaction: [`decorateFormForSubmit`](../src/app/tracker.js/route.ts#L194) *adds* `sl_tid`/`sl_vid`/`sl_vh` hidden inputs on GET forms and relies on the hidden-skip so lead capture never sees them. The `sl_` exclusion in the capture rule preserves that — verify it explicitly.

### ⚠️ Todo 3 + Todo 4 form a capture loop — the `sl_` exclusion does NOT stop it

**Found 2026-07-20. This is the one interaction that is easy to ship and hard to notice.**

Todo 4 injects the stored params as hidden inputs on cross-domain **GET** forms. Todo 3 reads hidden inputs whose name matches the tracking rules. `utm_source` matches rule 1 — and **these inputs are not `sl_`-prefixed, so the `sl_` exclusion above does not protect them.** We inject our own params, then read them straight back as if the client's page had put them there:

```
Todo 4 → appends <input type=hidden name=utm_source value=paidsocial>
Todo 3 → sees name matches rule 1 → captures it into extra_params
```

The values are identical to what storage already holds, so **no data is corrupted** — this is not a live bug, which is exactly why it would survive review. What it does mean: `extra_params` can no longer be described as "params the client's page carried," and the loop is uncontrolled if either side's rules change.

**Fix when implementing Todo 4:** mark our injected inputs (e.g. a `data-sl` attribute set at creation) and have Todo 3's hidden-input reader skip any input carrying it. Marker on the element, not a name-prefix rule — the whole point is that these have the client's names.

**Order of work matters:** if Todo 4 ships before Todo 3's hidden-input reading, the loop cannot exist yet. If Todo 3 ships first, add the skip *with* Todo 4, in the same change.

---

# ✅ Todo 4 — Forward params on cross-domain navigations — DONE

**Priority: low-medium. Small change, inherits existing coverage.**

### The problem

[`tracker.js:173-186`](../src/app/tracker.js/route.ts#L173-L186):

```js
u.searchParams.set("sl_tid", _ctx.tid);
u.searchParams.set("sl_vid", _ctx.vid);
u.searchParams.set("sl_vh",  _ctx.vh);
```

Three params, ours only. **No UTM is ever forwarded to another domain.**

### Relationship to `url-conversion-v2`

**Related, not blocked.** That project built the interception machinery — links ([`decorateLink`](../src/app/tracker.js/route.ts#L187)), forms ([`decorateFormForSubmit`](../src/app/tracker.js/route.ts#L194)), `window.open` ([`patchWindowOpen`](../src/app/tracker.js/route.ts#L228)), and `location.href` (`watchNavigations`). This todo asks that machinery to carry additional cargo. The unfinished parts of `url-conversion-v2` do not hold it up.

**On the 87% figure:** it mostly doesn't apply here. Links, forms, and `window.open` are patched directly and work on **every browser**. The 87% Navigation-API ceiling applies only to JS-driven `location.href`. The client said *"if it clicks out"* — that's the click path, fully covered.

### The fix

Add stored params (from Todo 2) to the decorated URL alongside the `sl_*` set. **Todo 2 is a prerequisite** — reading `window.location.search` inside `decorate()` reintroduces the page-2 bug.

### ⚠️ Decouple params from the `_ctx` gate

**Found 2026-07-20.** The first line of [`decorate()`](../src/app/tracker.js/route.ts#L175) is:

```js
if (!_ctx || !url) return url;
```

The naive reading of "add params after the guards" puts param-forwarding **behind this gate**. That is wrong, because the two payloads have different requirements:

| Payload | Needs `_ctx`? | Why |
|---|---|---|
| `sl_tid` / `sl_vid` / `sl_vh` | **Yes** — the values *are* `_ctx` | can't send what doesn't exist |
| `utm_*` / `hsa_*` / click IDs | **No** — they live in `localStorage` (Todo 2) | independent of variant assignment |

Gating both together means we drop attribution in two situations where we demonstrably still have it:

1. **The ~1s redirect/proxy boot window** while `/api/resolve` is in flight (see the `_ctx` note in Cross-cutting).
2. **`/api/resolve` failing outright** — network error, deleted test, visitor cap. `_ctx` is never set, so *every* cross-domain jump that session loses its UTMs, permanently.

The existing doc line "not made worse by any todo here" is true for **conversions** and false for **Todo 4**. Attribution is precisely the thing that should still work when variant tracking doesn't.

**Implement as:** restructure so the `sl_*` block is `_ctx`-gated but the param block is gated only on "storage has params." Keep the same-hostname and non-http(s) early-returns applying to **both** — those are correctness guards, not context guards.

### Trade-off: this does restart GA sessions cross-domain

The "Rejected alternative" section above declines to decorate **same-domain** links partly because a UTM-tagged pageview makes GA open a new campaign session, inflating sessions and collapsing bounce rate. **That same effect applies here** whenever the client owns both domains and has GA cross-domain tracking configured.

The difference is that cross-domain has **no storage-based alternative** — `localStorage` physically cannot cross the origin, so it is URL-passing or nothing. Accepted deliberately: the client's complaint was blank attribution, and blank attribution is worse than a re-attributed session.

**Recorded so the two sections don't read as contradicting each other.** If a client later reports GA session inflation after Todo 4, this is the cause and it is known — the fix is GA-side (referral exclusions / cross-domain linker config), not reverting Todo 4.

### Break-risk check

- **Do not touch the early-returns** at [`L179`](../src/app/tracker.js/route.ts#L179). The `sl_vid`/`sl_tid` check is what stops `SplitLab.go` and `watchNavigations` from double-appending (see url-conversion-v2-plan.md). Adding params must happen *after* those guards, never before.
- **Precedence:** if the destination URL already has a param, leave it. Explicit beats inherited.
- **GET-form path is the delicate one.** [`decorateFormForSubmit`](../src/app/tracker.js/route.ts#L194) converts params to hidden inputs for GET forms, and reads them back out of the decorated URL rather than off `_ctx` (deliberate — see commit `368553b`). Extending it means ~10 more hidden inputs per form. Confirm this doesn't collide with a destination form field of the same name, and that the `sl_`-exclusion in Todo 3's capture rule stops these being re-captured as leads.
- **URL length:** `sl_*` (3) + ad params (up to 13) + existing destination params. Cap total decorated length ~2000 chars; if exceeded, keep `sl_*` and drop extras — **tracking integrity beats attribution completeness**.
- **Same-domain still returns early** at [`L178`](../src/app/tracker.js/route.ts#L178). That's correct — same-domain is Todo 2's job via storage.
- **Both files again:** `tracker.js` and `tracking.ts` (`decorate` at [`tracking.ts:142`](../src/lib/tracking.ts#L142)).

---

# Recommended sequence

**2 → 1 → 3 → 4** — *unless the affected client is on proxy mode, in which case **1 → 2 → 3 → 4** (see the proxy warning in the coverage matrix: Todo 2 does nothing for proxy until Todo 1 lands).*

1. **Todo 2** first — remembering params is a safety net under everything else, and it fixes the literal complaint.
2. **Todo 1** next — confirmed self-inflicted bug, cheap, no schema change.
3. **Todo 3** third — needs a migration, deserves its own review.
4. **Todo 4** last — with 2 in place this is belt-and-braces rather than load-bearing.

**2 + 1 together fix the complaint Renny actually raised.** Todo 3 adds new data rather than recovering lost data, so it can ship separately if speed matters.

---

# Test plan

**Golden rule, inherited from url-conversion-v2:** `implement → npm run build → live-test that specific case → confirm green`. Do not batch two todos into one test cycle — when it fails you won't know which one did it.

## Ground rules that make results trustworthy

These are the traps that have already cost test cycles on this codebase. Every one is load-bearing:

1. **Use incognito, one fresh window per case.** `sl_visitor` is a 90-day cookie and `sl_tracking` / `sl_params` are 90-day localStorage. A stale entry from the previous case will make a broken build look green.
2. **Use the raw test URL `/<slug>/<testId>`. Never the dashboard Open button** — it injects `sl_vh` (`forcedVh`), which suppresses pageview recording and cookie-setting throughout [`serve/route.ts`](../src/app/api/serve/route.ts).
3. **In proxy mode, read the console from inside the iframe** (DevTools frame selector). The top frame is a different origin running a different script and will look idle.
4. **`sendBeacon` is fire-and-forget.** A 200 in the Network tab is *not* confirmation, and response bodies aren't even visible for beacons. **The dashboard row is the only real confirmation.**
5. **Check the DB, not just the UI**, for anything touching `extra_params` — the table renders a subset.

## Test rigs

| Mode | Test ID |
|---|---|
| Redirect | `579167ba-88c9-451d-966d-a8b5ab5ca821` |
| HTML | `b8fc1df6-3f6e-48ef-a6d1-9b6f8bdacacb` |
| Proxy | `609c84aa-a5b8-4cc5-9c5f-70a0ea69103c` |

## The canonical test URL

Use the client's real string every time, so `fbc_id` vs `fbclid` and the `hsa_*` set are always exercised:

```
?fbc_id=123&h_ad_id=456&utm_source=paidsocial&utm_medium=testadset
&utm_campaign=testcamp&utm_content=testad&hsa_acc=999368881986267
&hsa_cam=120240244340500249&hsa_grp=120247816737200249&hsa_ad=120247816737210249
&hsa_src=fb&hsa_net=facebook&hsa_ver=3
```

**13 params. Count them on arrival every time** — "the UTMs came through" is not a result, "13 of 13 present" is.

---

## Per-todo verification

### Todo 1 — server-side forwarding

| # | Case | Steps | Pass condition |
|---|---|---|---|
| 1.1 | Redirect mode | Hit redirect rig raw URL + canonical string | Destination address bar has **all 13** + `sl_vid` + `sl_vh` |
| 1.2 | Proxy mode | Hit proxy rig + canonical string, inspect **iframe** `src` | iframe src has all 13 + `sl_vid` + `sl_vh` |
| 1.3 | HTML mode unaffected | Hit HTML rig + canonical string | Behaves exactly as before (no redirect path runs) |
| 1.4 | Deny-list holds | Same as 1.1, inspect destination URL | **No** `domain`, `path`, `preview_test_id`, `sl_scan`, `sl_tid`; `sl_vid`/`sl_vh` appear **exactly once each** |
| 1.5 | Precedence | Set a `redirect_url` containing `utm_source=configured`, arrive with `utm_source=paidsocial` | Destination shows `configured` — saved URL wins |
| 1.6 | Cap | Arrive with 60 junk params | Forward truncates, no error, `Location` header stays sane |
| 1.7 | `forcedVid` not hijackable | Arrive with `?sl_vid=<other-variant-id>` | Assignment unchanged — forwarded value must not pin a variant |

### Todo 2 — storage

| # | Case | Steps | Pass condition |
|---|---|---|---|
| 2.1 | **The literal complaint** | Land page 1 with canonical string → click to page 2 (clean URL) → submit form on page 2 | Lead row carries the full param set |
| 2.2 | No empty overwrite | After 2.1, load page 3 with no params | `sl_params` still holds page 1's values |
| 2.3 | Last-touch replace | Arrive `utm_source=fb`, then re-arrive `utm_source=google&utm_campaign=x` | Stored set is **wholly** google's — no `fb` fragment mixed in |
| 2.4 | Live URL wins | Store fb params, then submit on a page whose URL has `utm_source=direct` | Lead row shows `direct` |
| 2.5 | Blocked storage | Safari "block all cookies" / storage disabled | No exception, page functional, lead still sends (params empty) |
| 2.6 | Expiry | Hand-edit stored timestamp to >90 days old | Treated as stale, not used |
| 2.7 | No PII stored | Arrive with `?email=a@b.com&session=xyz&utm_source=fb` | `sl_params` contains **only** `utm_source` |
| 2.8 | Proxy, post-Todo-1 | Todo 1 shipped → proxy rig → navigate inside iframe → submit | Params survive **inside the iframe origin** |

### Todo 3 — arbitrary params

| # | Case | Pass condition |
|---|---|---|
| 3.1 | Full capture | All 13 land: 7 in their existing columns, remaining 6 in `extra_params` |
| 3.2 | **No duplication** | `utm_source` is in its column and **not** in `extra_params` |
| 3.3 | `fbc_id` ≠ `fbclid` | Both present and distinct when the URL carries both |
| 3.4 | Rule 4 is not a bare regex | Arrive with `user_id`, `session_id`, `order_id` → **none captured** |
| 3.5 | `sl_` never captured | No `sl_*` key anywhere in `extra_params` |
| 3.6 | Hidden inputs | A client hidden `utm_source` input is read; a hidden CSRF/session input is **not** |
| 3.7 | **Todo 3+4 loop** | Our own injected hidden inputs are skipped (see the loop section in Todo 3) |
| 3.8 | Server re-applies caps | POST a crafted payload with 200 params / 10KB directly — server truncates, does not trust the client |
| 3.9 | Historical rows | An existing pre-migration lead reads back `extra_params = {}`, renders fine |

### Todo 4 — cross-domain forwarding

Run **each** row against **all three modes**:

| # | Navigation | Pass condition |
|---|---|---|
| 4.1 | Left-click cross-domain link | Destination URL has `sl_*` **and** the params |
| 4.2 | Middle-click / ctrl+click | Same (exercises `auxclick`) |
| 4.3 | **Keyboard Tab + Enter** | Same (exercises the `click` listener — the case a mousedown-only binding drops) |
| 4.4 | `window.open()` | Same |
| 4.5 | Cross-domain GET form | Params arrive as hidden inputs, marked so Todo 3 skips them |
| 4.6 | Cross-domain POST form | `action` rewritten |
| 4.7 | `location.href` | Works on Chrome/Edge/Safari 26.2+/FF 147+; **no-op elsewhere, not an error** |
| 4.8 | Same-domain link | **Still early-returns undecorated** — no URL pollution, GA untouched |
| 4.9 | Destination already has `utm_source` | Left alone — explicit beats inherited |
| 4.10 | `_ctx` decoupling | Kill `/api/resolve` (devtools block) → params **still forward**, `sl_*` correctly absent |
| 4.11 | Length cap | Long destination URL → `sl_*` retained, extras dropped first |
| 4.12 | `<a download>` cross-domain | Still downloads, not navigated |
| 4.13 | Back/forward | Untouched (traverse is skipped) |

---

# Regression suite — run before every merge

**Nothing below is part of this work. Every item is existing production behaviour that these todos sit next to and could plausibly disturb.** Run the whole list — the cheap ones take seconds and the expensive failures are the silent ones.

## Tier 1 — touched code paths, highest risk

| Area | Check | Why it's at risk |
|---|---|---|
| **Variant assignment** | Same visitor + test → same variant across reloads; traffic split still respects `traffic_weight` | Todo 1 edits the same block in `serve/route.ts` |
| **Sticky cookies** | `sl_visitor` (90d) and `sl_test_{testId}` still set once, correct flags | Set immediately after the URL-building Todo 1 changes |
| **`sl_vid` / `sl_vh` exactly once** | Inspect destination URL | Deny-list is the only thing preventing a double-set |
| **`forcedVid` / `preview_test_id`** | Dashboard preview still pins its variant; `preview_test_id` never leaks downstream | Both read from the query string Todo 1 now forwards |
| **Scan mode** | `?sl_scan=1` → banner appears, scan POSTs fire, no pageview recorded | `isScan` handled separately from the forward |
| **Open button** | Still suppresses pageviews + cookies (`forcedVh`) | Shares the query-param surface |
| **Visitor cap** | Over-cap still serves without tracking snippet | Same conditionals |

## Tier 2 — conversion pipeline (separate from leads, must stay separate)

| Area | Check |
|---|---|
| **Pageview dedup** | Still one per visitor/test/day — reload 3× → one row |
| **`url_reached` goals** | Fire same-domain in all three modes (the url-conversion-v2 result must still hold) |
| **Button / click goals** | Still fire; `goal_id` auto-matched from `metadata.trigger` |
| **`fields:` selector goals** | `formFieldSignature()` unchanged — **Todo 3's hidden-input reading must not reach `fieldKey()`** |
| **Stale-test soft-fail** | Conversion for a deleted test still returns `200 {stale:true}`, not 500 |
| **Method 1-4 detection chain** | Unbroken — **`sl_tracking` and `sl_ctx` must be untouched by Todo 2's new `sl_params` key** |
| **Statistics** | Chi-square / significance numbers unchanged for an untouched test |

## Tier 3 — lead pipeline and integrations

| Area | Check |
|---|---|
| **The 7 existing columns** | Still populated **identically**. Compare a fresh lead against a pre-change one, same inbound URL |
| **Multi-step forms** | `_accumulatedFormData` still merges every step |
| **JS/div-form capture** | Still fires once — `_leadSent` dedup intact |
| **Empty-submission reject** | Still returns `{ok:true}` without inserting |
| **Password/file/hidden skip** | **No password value ever reaches `form_fields`** — re-verify explicitly, Todo 3 edits this exact filter |
| **HubSpot sync** | Existing mappings still sync; token refresh still works; counters increment |
| **Email notification** | Still sends with correct variant name |
| **Webhook** | Still fires; existing `SYSTEM_FIELD_KEYS` mappings unchanged |
| **Field-mapping dropdown** | [`form-field-keys`](../src/app/api/tests/[id]/form-field-keys/route.ts) shows **form fields only** — no ad params polluting the list |
| **CSV export** | Opens correctly in Excel/Sheets with the widened header |
| **Leads table** | Horizontal scroll inside the container — **page body must not scroll sideways** |

## Tier 4 — adjacent features that share the query string or storage

| Area | Check |
|---|---|
| **Affiliate `sl_ref`** | [`middleware.ts:106`](../src/middleware.ts#L106) cookie still set; not swallowed by the forward |
| **UTM personalization rules** | Migrations 032-034. **These read UTMs too** — confirm Todo 1/2 changes don't alter which rule matches |
| **Naked-domain 301** | `trysplitlab.com` → `www.` still preserves the query string |
| **CORS** | `/api/event`, `/api/resolve`, `/tracker.js` still bypass auth, still echo origin dynamically |
| **Custom domain rewrite** | Still resolves domain → workspace → test |
| **Auth guard** | Dashboard still protected; `/login` still redirects when logged in |
| **Favicon / logo** | Still injected (`buildFaviconTag`) |

## Cross-cutting regression checks

- [ ] **`npm run build` passes** — the only gate configured; no test framework exists.
- [ ] **`npm run lint` clean.**
- [ ] **Both files changed together.** `tracker.js` and `tracking.ts` diffs reviewed **side by side** for every todo. This is the documented most-likely failure mode of this entire project — a checklist item, not a reminder.
- [ ] **Every mode retested after every todo**, not just the one the todo names.
- [ ] **A test with no UTMs at all still works end to end** — the null path is the one nobody tests and most visitors take.
- [ ] **A pre-existing lead and a pre-existing test** both still render in the dashboard.

## Sign-off matrix

Do not merge until every cell is green. **All three modes, every time** — a todo that fixes redirect and quietly breaks proxy is the shape of failure this project keeps producing.

| | HTML | Redirect | Proxy |
|---|---|---|---|
| Arrival keeps 13/13 params | ☐ | ☐ | ☐ |
| Same-domain page 1 → page 2 → submit | ☐ | ☐ | ☐ |
| Cross-domain click | ☐ | ☐ | ☐ |
| Cross-domain form | ☐ | ☐ | ☐ |
| Lead row correct in dashboard | ☐ | ☐ | ☐ |
| `url_reached` conversion still fires | ☐ | ☐ | ☐ |
| Existing 7 columns unchanged | ☐ | ☐ | ☐ |

---

# Cross-cutting notes

- **Two parallel implementations.** [`tracker.js/route.ts`](../src/app/tracker.js/route.ts) (external destination pages) and [`lib/tracking.ts`](../src/lib/tracking.ts) (injected into SplitLab-served HTML). Nearly every change here lands in both. Fixing one silently leaves some modes broken — **this is the single most likely way this work ships half-done.**
- **Three duplicate allowlists** (`tracker.js:799`, `tracker.js:839`, `tracking.ts:325`). Consider one shared constant.
- **`_ctx` gate.** All lead capture returns early if `_ctx` is null ([`tracker.js:782`](../src/app/tracker.js/route.ts#L782), [`L829`](../src/app/tracker.js/route.ts#L829)). The ~1s undecorated boot window in redirect/proxy mode (url-conversion-v2-plan.md L588-604) applies to leads identically. Worth knowing when a lead goes missing.
  - **Amended 2026-07-20:** "not made worse by any todo here" holds for lead capture and conversions, but **not for Todo 4** — see *Decouple params from the `_ctx` gate* there. Params must not inherit a gate that exists for variant context.
- **Testing traps** (from url-conversion-v2-plan.md): use incognito + the raw test URL `/<slug>/<testId>`, never the dashboard **Open** button (it injects `sl_vh` and suppresses events). In proxy mode read the console **from inside the iframe**. `sendBeacon` is fire-and-forget — **the dashboard is the only real confirmation**.
- **Test rigs:** redirect `579167ba-88c9-451d-966d-a8b5ab5ca821` · HTML `b8fc1df6-3f6e-48ef-a6d1-9b6f8bdacacb` · proxy `609c84aa-a5b8-4cc5-9c5f-70a0ea69103c`

# Pre-existing bugs found while investigating (out of scope, worth logging)

1. **Unescaped search filter** — [`api/tests/[id]/form-leads/route.ts:53`](../src/app/api/tests/[id]/form-leads/route.ts#L53) interpolates `search` into a PostgREST `ilike` filter. `,` and `)` are structural in that grammar, so ordinary input can error or alter the filter tree. Behind auth and scoped by `test_id`, so not a data-exfil path — but a real correctness bug.
2. **PII in logs** — [`api/form-leads/route.ts:210`](../src/app/api/form-leads/route.ts#L210) does `console.log('[hubspot-sync] ok — testId:', params)`, logging the whole object including `formFields` — every lead's name, email, and phone in plaintext in Vercel logs. Almost certainly meant to be `params.testId`.
3. **Webhook/HubSpot system-field mismatch** — `webhook.ts` `SYSTEM_FIELD_KEYS` omits `gclid`/`fbclid`; `hubspot.ts` `SYSTEM_FIELDS` includes them. Natural to fix inside Todo 3.
