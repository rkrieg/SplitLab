# Event Discovery Feed - Research & Implementation Plan

## What the Client Wants

Non-technical users should be able to set up conversion tracking without writing code, adding IDs to HTML, or manually typing selectors. The experience should be:

1. Add one script tag to your site
2. Click "Scan Page" in the dashboard
3. See a list of everything on the page
4. Click "Enable as Goal" on the ones you care about
5. Done - those now count as conversions

**Client's exact words (May 2026):**
> "I would say we would just want a bot to go in and do a sweep and test and click anything you can so that that stuff automatically shows up, and they can just select everything that's possibly available on the page."

Client confirmed our approach: "Ok so same thing just different approach yea that works."

---

## Confirmed Approach: tracker.js Scan Mode

The "bot" does NOT need to be a headless browser. tracker.js already runs in the real browser on the client's page — after all JavaScript has executed. So it can read the fully rendered DOM including React/SPA-rendered buttons.

**Why this beats a server-side HTML fetch:**
- Server-side fetch misses React/JS-rendered elements (gets empty `<div id="root">`)
- tracker.js runs in the real browser AFTER JS executes — sees everything

**Flow:**
1. User clicks "Scan Page" in the dashboard
2. Dashboard automatically opens `page_url?sl_vid=xxx&sl_scan=1` in a new tab
3. tracker.js boots, detects `sl_scan=1`, scans the DOM
4. Finds all: forms, buttons (with text + id), tel links, CTA links
5. POSTs results to `/api/scan`
6. Dashboard shows the list, user enables goals

---

## Does Scanner Work on All Test Types?

| Type | Works? | Why |
|---|---|---|
| Custom HTML | Yes, always | tracker.js auto-injected by SplitLab |
| Hosted URL - Proxy | Yes, always | tracker.js auto-injected by SplitLab |
| Hosted URL - Redirect | Yes, IF tracker.js is on their external page | SplitLab redirects to external page, tracker.js must already be installed there |

**Redirect mode note:** If tracker.js is not on their page, nothing works anyway (no conversions either). Not a new limitation. We also need to forward `?sl_scan=1` through the redirect in the serve route — small change.

---

## Where to Store Scan Results

**JSON field on the `tests` table** (`scan_results jsonb`).

Scan results are just a snapshot of what is on the page. Once the user enables goals, those go into `conversion_goals` as always. Scan results do not need their own history or relationships. One migration line, no separate table needed.

```json
{
  "scanned_at": "2026-05-24T...",
  "elements": [
    { "type": "form", "id": null, "text": null },
    { "type": "button", "id": "hero-cta", "text": "Get Started" },
    { "type": "button", "id": "footer-cta", "text": "Buy Now" },
    { "type": "call", "id": null, "text": "+1 (555) 123-4567" }
  ]
}
```

---

## Goal Matching: Selector/ID Based

tracker.js currently captures button text only. We update it to also capture element ID:
```js
{ trigger: "button_click", text: "Get Started", id: "hero-cta" }
```

When a goal is created from a scanned element, the element ID is stored in the existing `selector` column of `conversion_goals`.

**Matching logic in `/api/event`:**
- If goal has `selector` → match only events where `metadata.id === selector`
- If goal has no `selector` → match all events of that type (current fallback behavior)

**Example — page with two identical buttons:**
```html
<button id="hero-cta">Get Started</button>   <!-- top of page -->
<button id="footer-cta">Get Started</button>  <!-- bottom of page -->
```

Scanner shows both separately:
```
Button: "Get Started"  [id: hero-cta]   [Enable as Goal]
Button: "Get Started"  [id: footer-cta] [Enable as Goal]
```

User enables only hero button. Goal stored: `type: "button_click", selector: "id:hero-cta"`

- Visitor clicks hero → `metadata.id = "hero-cta"` matches → **conversion counted**
- Visitor clicks footer → `metadata.id = "footer-cta"` does not match → **not counted**

**Selector field uses a prefix convention:**

| Button | Selector stored | Matches |
|---|---|---|
| `<button id="hero-cta">Get Started</button>` | `id:hero-cta` | Only that specific button by ID |
| `<button>Get Started</button>` (no id) | `text:Get Started` | Only buttons with that exact text AND no id |
| `<button></button>` (no id, no text) | `null` | All button_clicks (very rare fallback) |

**Matching logic in `/api/event`:**
```
selector starts with "id:"   → match if metadata.id   === value
selector starts with "text:" → match if metadata.text === value AND metadata.id is null
no selector                  → match all of that type
```

**Critical rule: if a button has an ID, it can only be matched by ID, never by text.** This prevents a text-based goal from accidentally catching buttons it was not meant for.

---

**Real world case: 1 button with ID + 1 without ID, both text "Get Started"**

```html
<button id="hero-cta">Get Started</button>   <!-- has ID -->
<button>Get Started</button>                  <!-- no ID, same text -->
```

Scanner shows 2 separate rows (distinguishable because one has ID):
```
Button: "Get Started"  [id: hero-cta]  [Enable as Goal]
Button: "Get Started"  [no id]         [Enable as Goal]
```

Goal A if enabled: `selector: "id:hero-cta"`
Goal B if enabled: `selector: "text:Get Started"`

**Case 1: Both enabled**
| Click | metadata | Goal A | Goal B |
|---|---|---|---|
| Hero button | id="hero-cta", text="Get Started" | MATCH | Skipped — has id |
| No-ID button | id=null, text="Get Started" | No match | MATCH |

Each button tracked separately. Clean.

**Case 2: Only Goal A enabled (hero only)**
| Click | Counts? |
|---|---|
| Hero button | Yes |
| No-ID button | No |

**Case 3: Only Goal B enabled (no-ID button only)**
| Click | Counts? |
|---|---|
| Hero button | No — has id, text matching excluded |
| No-ID button | Yes |

**Case 4: Neither enabled**
Nothing counts.

---

**Accepted limitation:** 2 buttons with same text AND no ID → scanner shows them as one row → one goal → both count together.

**How Phase 2 (visual selector) solves this:** Phase 2 works by generating a CSS selector path based on where the element sits in the DOM. User opens an overlay on their page and clicks the specific element. The tool generates a unique path using parent elements e.g. `.hero > button` vs `.footer > button`. Even with identical text and no IDs, the DOM structure makes them distinguishable. tracker.js then matches using `element.matches(cssSelector)`.

---

## Full TODO List

**1. tracker.js**
- Detect `?sl_scan=1` on page load
- If scan mode: scan DOM for forms, buttons (text + id), tel links, CTA links
- POST results to `/api/scan`
- Clean `sl_scan` from URL (same pattern as `sl_tid`, `sl_vid`)
- Also capture element `id` on button_click events (add to existing tracking)

**2. Database migration**
- Add `scan_results jsonb` column to `tests` table

**3. New API: `POST /api/scan`**
- Receives element list from tracker.js
- Stores in `tests.scan_results` for that test ID
- Must be public (no auth) — tracker.js calls it from client's browser

**4. New API: `GET /api/tests/[id]/scan-results`**
- Auth protected
- Returns `test.scan_results` to dashboard

**5. Serve route (`/api/serve`)**
- Forward `sl_scan=1` param through redirect variants

**6. Dashboard UI (`AnalyticsClient.tsx`)**
- "Scan Page" button in Settings tab
- On click: open `page_url?sl_vid=variantId&sl_scan=1` in new tab automatically
- Poll `/api/tests/[id]/scan-results` until results arrive
- Show list: Form, Button "Get Started", Button "Buy Now" etc.
- "Enable as Goal" creates goal with element ID stored in `selector`

**7. Goal matching (`/api/event`)**
- Update auto-match logic: if goal has `selector` → match `metadata.id === selector`
- If no selector → current behavior (match all of that type)

---

## What tracker.js Already Does (Right Now)

The global script (`src/app/tracker.js/route.ts`) already auto-detects and fires events for:

- **Form submits** - any `<form>` submission on the page (line 120-122)
- **Button clicks** - any `<button>`, `[role="button"]`, `input[type="submit"]` outside a form (line 135-140), captures button text
- **Call link clicks** - any `<a href="tel:...">` click (line 129-132)
- **CTA link clicks** - any link with class containing `btn`, `button`, `cta` or `role="button"` (line 142-151)
- **URL reached** - checked against configured goals on page load + SPA navigation (line 157-182)

Uses event delegation (single listener on `document`) - works for dynamically rendered elements too (React/SPA).

### Key Limitation

Line 100: `if (!_ctx) return;`

Events only fire when the visitor has a test context (assigned via `sl_vid`, `sl_tid`). Scan mode uses `sl_vid` so this is satisfied.

---

## How Goals Currently Work

Goals match by trigger TYPE automatically — no HTML changes needed.

- Script fires `{ trigger: "form_submit" }` on any form submit
- If a `form_submit` goal exists for that test → counts as conversion
- With the new selector matching: if goal also has a selector, only matching element ID counts

---

## Relation to Client's Technical Spec (`conversion-pixel-technical-spec.pdf`)

| Client's Spec | SplitLab Current Status |
|---|---|
| Global pixel snippet | tracker.js - EXISTS |
| Auto-detect form submits | wireAutoConversions() - EXISTS |
| Auto-detect button clicks | wireAutoConversions() - EXISTS |
| sendBeacon delivery | send() function - EXISTS |
| SPA route change handling | wireUrlGoals() - EXISTS |
| URL contains/equals rules | url_reached goal type - EXISTS (exact match only) |
| /collect endpoint | /api/event - EXISTS |
| Dashboard configurable by typing | Goals UI - EXISTS |
| Page scanner / element discovery | NOT BUILT - Phase 1 priority |
| Visual element selector overlay | NOT BUILT - Phase 2 |

---

## Notes on Previous Developer's Claims

**Claim 1**: "Conversion tracking is only possible when goals are set"
- **Partially correct** for current implementation. Without goals, events fire but don't count as conversions.

**Claim 2**: "The only way to configure goals is to add an ID in goals and add the same ID to the actual HTML forms/buttons"
- **Wrong**. Goals match by trigger TYPE automatically. No HTML changes needed.
