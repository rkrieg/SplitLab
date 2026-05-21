# BE Architecture Deep-Dive: Pages, Tests & Variants

### The Core Mental Model

The system has **two separate concepts** that the UI conflates into one "Pages" view:

```
Workspace
 └── Test (url_path, status, name, head_scripts)
      ├── test_variants[]  ← variant A, B, C…
      │    ├── page_id → pages (html_url, html_content)   ← custom HTML path
      │    └── redirect_url                               ← hosted URL path
      └── conversion_goals[]
```

A **Test** = the A/B experiment sitting at a URL path (e.g. `/landing`). It's the container.  
A **Variant** = one "version" of that page shown to a bucket of visitors.  
A **Page** = a stored HTML blob. It only exists when you use the custom HTML path.

---

### The Two Creation Paths (Your Key Finding)

| | Custom HTML | Hosted URL |
|---|---|---|
| Frontend route | `POST /api/pages/from-html` | `POST /api/workspaces/[id]/tests` |
| Creates `pages` row? | ✅ Yes — HTML stored in Supabase Storage + `pages` table | ❌ **No** — only `tests` + `test_variants` |
| `test_variants.page_id` | UUID pointing to the page | `null` |
| `test_variants.redirect_url` | `null` | the destination URL |
| Serve mode | Section 6c in `serve/route.ts` — reads HTML, injects everything | Section 6a — builds iframe wrapper |

This is the root cause of every script bug you're hitting.

---

### How Script Injection Works (and Why It Breaks)

In `serve/route.ts`, scripts are fetched in two buckets every time:

```typescript
// Workspace-level: page_id IS NULL → applies to everything
workspaceScripts: db.from('scripts').select('*').eq('workspace_id', workspaceId).eq('is_active', true).is('page_id', null)

// Page-scoped: page_id = variant's page_id
pageScripts: selectedVariant.page_id
  ? db.from('scripts').select('*').eq('workspace_id', workspaceId).eq('is_active', true).eq('page_id', selectedVariant.page_id)
  : Promise.resolve({ data: [] })   // ← if page_id is null, this returns NOTHING
```

The "Apply To" dropdown in `ScriptsClient.tsx` only shows rows from the `pages` table — rows that were created by the HTML path. **Hosted URL pages don't create a `pages` record, so they never appear in the dropdown at all.**

This explains the exact weird behavior you described:

| Assignment | Custom HTML page | Hosted URL page |
|---|---|---|
| "All Pages (workspace)" (`page_id = null`) | ✅ Injected | ✅ Injected |
| Specific custom HTML page | ✅ Injected (page_id matches) | ❌ Not injected (page_id is null, never matches) |
| Only hosted URL page | ❌ **Can't even select it** — it's not in the dropdown | — |

So "assign to ALL pages works for hosted URL" because that's the `page_id IS NULL` workspace-level case. But "assign ONLY to hosted URL page" is impossible — the option literally doesn't exist in the UI. The hosted URL page is invisible to the scripts system.

---

### The Proxy Mode Problem (Even Deeper)

Even if you fix the page assignment, there's a second layer problem. For hosted URL variants, the serve route builds **an iframe wrapper**:

```html
<!-- This HTML is served from YOUR domain (trysplitlab.com) -->
<head>
  ${headScriptTags}   ← GTM/GA4/Meta Pixel injected HERE
</head>
<body>
  <iframe src="https://their-actual-site.com/page?sl_vid=..."></iframe>
  ${proxyTrackingSnippet}   ← SplitLab tracker fires HERE
</body>
```

Scripts injected into this wrapper run **in your SplitLab domain context**, not in the actual site's context. GTM running in the wrapper can see the iframe element but **cannot reach into the iframe's DOM** if the destination is a different origin (cross-origin iframe restriction). So:

- ✅ The SplitLab tracker snippet works — pageviews fire, conversion events fire — because it runs in the wrapper's context and calls your `/api/event`
- ❌ GTM/GA4/Meta Pixel in the wrapper **fires for a page that has no real content** — the wrapper is just a `<style>` + `<iframe>` tag. No meaningful user interactions happen on it. All real user activity happens inside the iframe where your scripts can't reach
- ❌ The `head_scripts` field on the test (Settings tab) has the same problem for hosted URLs

---

### The `check-tracking` Bug

`check-tracking/route.ts` fetches the raw `redirect_url` and looks for `tracker.js` in the HTML. For **proxy mode** (which is the default for hosted URLs), the tracker is in the SplitLab wrapper — it's never on the raw destination URL. So it always reports ❌ "Tracker not found" for proxy-mode variants, even when tracking is working perfectly.

---

## Summary of All Bugs

1. **No `pages` record for hosted URL variants** → they're invisible to the scripts assignment system → you can never assign a page-scoped script to a hosted URL page

2. **Proxy mode injects scripts into the wrapper iframe HTML** → scripts run in the SplitLab domain context, not the actual destination page → GTM/GA4/pixel scripts are useless here because the wrapper has no content

3. **`head_scripts` on the test Settings tab** → same problem as #2 for proxy mode — injected into the wrapper, not the real page

4. **`check-tracking` does a false negative** → fetches the raw URL but for proxy mode the tracker is in the wrapper, never on the raw URL

---

### What Correct Architecture Should Look Like

**Option A (minimal fix — page-scoped scripts for hosted URLs):**  
When creating a hosted URL test, also create a `pages` row as a "virtual" page with no HTML content — just a placeholder to serve as the `page_id` anchor. Then the `test_variant.page_id` can point to it, and scripts can be assigned to it normally.

**Option B (correct design intent for proxy mode):**  
Scripts for hosted URLs need a different strategy entirely. You can't inject arbitrary scripts into third-party pages in an iframe due to cross-origin. The practical options are:
- Force the client to add `tracker.js` manually to their page (current redirect mode intent) — then the tracker picks up `sl_vid` from the URL
- Use a Service Worker on your domain to proxy the full page content (complex)
- In the wrapper, use `postMessage` bridging to communicate with the iframe — only works same-origin

**For now, the correct approach for proxy mode is:**
- The SplitLab tracking snippet in the wrapper → works fine for pageviews ✅
- Workspace-level scripts should probably NOT be injected into the proxy wrapper at all, or a clear warning shown
- Page-scoped "head scripts" in Settings tab should show a warning when the test only has hosted URL variants: "Head scripts are injected into the proxy wrapper and will not affect the content inside the iframe"

---

## Round 2 — Clarifications & Deeper Questions

### "New Page → Paste HTML" vs Variants — What Actually Happens Under the Hood

You're right to be confused — the wording was sloppy. Here's what actually happens when you click **"New Page"**:

**Paste a URL mode:**
```
creates → tests row  (url_path, name)
creates → test_variants row  (redirect_url = your URL, page_id = NULL)
creates → ❌ NO pages row
```

**Paste HTML mode:**
```
creates → pages row  (html_content, html_url)
creates → tests row  (url_path, name)
creates → test_variants row  (page_id = that page's UUID, redirect_url = NULL)
```

So **yes, "New Page → Paste HTML" absolutely creates a page**. What I meant — and this is the part that was unclear — is that each HTML page is attached to **one variant**, not to the test directly. The "New Page" flow creates the test + one Control variant + one pages record all at once. The UI hides this from you.

The point about variants: if you later click "Add Variant" on that same test and choose "Upload HTML", it creates a **second `pages` row** for Variant B. So Variant A has `page_id = page_A` and Variant B has `page_id = page_B`. Two separate HTML blobs. One test.

For hosted URL variants — same thing. Both variants are linked to the test via `test_id`, and both have `page_id = null`:
```
Variant A (hosted URL):  test_id = test_xyz,  page_id = null,  redirect_url = "https://clientsite.com/page-a"
Variant B (hosted URL):  test_id = test_xyz,  page_id = null,  redirect_url = "https://clientsite.com/page-b"
```

---

### The Proxy Wrapper is a Real HTML Page

When a visitor hits your custom domain and gets a hosted URL variant in proxy mode, SplitLab serves this actual HTML:

```html
<!DOCTYPE html>
<html>
<head>
  <!-- ↓ YOUR SCRIPTS LAND HERE -->
  <script>GTM code here...</script>
  <script>GA4 code here...</script>
  <style>html,body{height:100%}iframe{width:100%;height:100vh}</style>
</head>
<body>
  <!-- ↓ THE ACTUAL CLIENT SITE LOADS INSIDE THIS -->
  <iframe src="https://clientsite.com/landing?sl_vid=xxx"></iframe>

  <!-- ↓ SPLITLAB TRACKER ALSO LANDS HERE -->
  <script>SplitLab pageview tracking...</script>
</body>
</html>
```

This wrapper page is a **real web page served from your domain**. Scripts in it absolutely run. The visitor's browser loads them. Here is the correct breakdown — not "scripts are useless", but what specifically works and what doesn't:

### What Actually Works vs Doesn't Work

| Script / Use Case | Proxy Mode (iframe wrapper) | Redirect Mode |
|---|---|---|
| **SplitLab tracker — pageviews** | ✅ Works perfectly | ✅ Works (if client adds tracker.js to their page) |
| **SplitLab tracker — conversions** | ✅ Works (fires from wrapper) | ✅ Works (tracker.js on their page detects sl_vid) |
| **GA4 / Meta Pixel — pageview event** | ✅ Works — fires on YOUR custom domain URL | ❌ Never runs, user is already on client's site |
| **GTM — basic container load** | ✅ GTM loads on your domain | ❌ Never runs |
| **GTM/GA4 — tracking clicks INSIDE the iframe** | ❌ Cross-origin blocks this | ❌ Never runs |
| **GTM/GA4 — tracking form submits INSIDE the iframe** | ❌ Cross-origin blocks this | ❌ Never runs |
| **Custom script that does something on page load** | ✅ Runs in wrapper context | ❌ Never runs |

### Why "All Pages" Script Works for Hosted URLs — Explained

When you assigned GTM to "All Pages (workspace)", it worked because:
1. The GTM snippet loaded in the proxy wrapper
2. GTM fired a pageview for `yourcustomdomain.com/landing`
3. That IS a valid pageview — the user IS on your domain
4. The GA4/pixel/GTM received a real page hit

What you **cannot** do with that GTM is track what the user does **inside** the iframe — button clicks, form submits, scroll depth on the client's actual content. That part lives in a cross-origin iframe and is unreachable.

---

### Is Option A Actually Worth Doing?

**Sharp question. Honest answer: mostly no, with one narrow exception.**

Pageview tracking for hosted URLs already works without any script assignment:
- SplitLab's own tracker fires a pageview from the wrapper → `/api/event` ✅
- That's the tracking that matters for the A/B test data

What GTM/GA4/Meta Pixel in the wrapper adds on top of that is a **parallel pageview hit to the client's analytics account** (Google Analytics, Meta Ads Manager, etc.) — not to SplitLab. Some clients may want their GA4 dashboard to also show the visit. But this already works via workspace-level "All Pages" assignment. There is no scenario where you'd need GTM only on one specific hosted URL proxy wrapper and not others — that's an extremely niche need.

**Conclusion on Option A: Drop it. It solves a problem that isn't real for hosted URLs.** The only concrete benefit was granularity (apply to one hosted URL page vs all), but since scripts in proxy wrappers are only useful for parallel analytics pageviews anyway, workspace-level "All Pages" already covers that completely.

---

### What Actually Needs to Be Fixed (Revised Priority)

1. **Fix `check-tracking` false negative for proxy mode**
   - Where: `PagesClient.tsx` — the "Check [Variant Name]" buttons on the Pages list cards (the shield icons)
   - For proxy mode variants, instead of fetching the raw `redirect_url` and failing to find tracker.js there, it should detect `proxy_mode = true` and immediately report ✅ "Tracking active via proxy wrapper" without any HTTP fetch
   - The current behavior always shows ❌ ShieldX for proxy-mode variants even when tracking is working perfectly

2. **Disable / warn on `head_scripts` in Settings tab for redirect mode**
   - Where: `AnalyticsClient.tsx` Settings tab — the head scripts textarea
   - When ALL variants on a test have `redirect_url` set AND `proxy_mode = false` (pure redirect), the textarea should be disabled with a tooltip: *"Scripts cannot be injected in redirect mode. The visitor is redirected directly to the destination URL — SplitLab serves no HTML."*
   - For proxy mode, leave it enabled but add an info note: *"Scripts run in the SplitLab proxy wrapper. They cannot access content inside the iframe if the destination is on a different domain."*

3. **The scripts dropdown (ScriptsClient) — no fix needed for hosted URLs**
   - Drop Option A entirely. Hosted URL pages should NOT be added to the dropdown. The workspace-level "All Pages" option is sufficient and correct for proxy-mode analytics needs.

4. **Redirect mode = explicitly unsupported for script injection**
   - The UI should make this clear rather than silently doing nothing
