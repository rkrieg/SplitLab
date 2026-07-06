# AI Landing Page Builder — Decisions

> Locked decisions for Feature 1. UTM personalization (Features 2 & 3) is out of scope for v1.

---

## What we're building

A Lovable-style AI page builder inside SplitLab:

1. User enters a prompt (+ vertical selector: lead gen, SaaS, local services)
2. AI generates page content and full HTML/CSS
3. User previews in an iframe, edits text inline, publishes
4. Published page works **exactly like today's custom HTML pages** — custom domain, `tracker.js` injected

---

## Architecture

```
Prompt + vertical
  → API 1: Claude returns schema_json (flexible, per-page)
  → API 2: Claude returns full HTML/CSS (with data-field attributes on editable text)
  → Save to pages table + Supabase Storage
  → Preview: iframe loads the HTML file
  → Inline edit: update HTML + schema_json together
  → Publish: create test + variant with page_id (same as paste-HTML flow)
  → Serve: existing /api/serve on custom domain
```

**We chose Claude-writes-HTML** (not fixed React templates) so every page can look visually unique.

---

## schema_json

- **Dynamic structure** — not a fixed template shape; varies per page
- Stores editable text fields keyed to match `data-field` attributes in the HTML
- Used for inline editing and future UTM field swapping
- Saved in a new `schema_json` column on `pages`

Example:

```json
{
  "vertical": "lead_gen",
  "fields": {
    "hero.headline": "Injured in a Miami Car Accident?",
    "hero.subhead": "Free case review. No fee unless we win.",
    "hero.ctaText": "Get Your Free Consultation"
  }
}
```

**Text lives in both places:** real text is baked into the HTML; `schema_json` is a parallel copy. On edit, update both to stay in sync. Visitors see the HTML directly — no `{{placeholder}}` rendering at serve time.

---

## Storage & hosting (same as custom HTML today)

| Column | Purpose |
|--------|---------|
| `html_url` | Public URL to file in Supabase Storage `pages` bucket |
| `html_content` | Copy of HTML in DB row (faster serve; optional if > 500KB) |
| `schema_json` | Editable field map (new column) |

Flow: `test_variants.page_id` → `pages` row → serve loads `html_content` if present, else fetches from `html_url`.

- **`pages.trysplitlab.com`** — deferred, not v1

---

## Inline editing

- Click text in iframe preview → `contentEditable` on `data-field` elements
- On save/blur: patch HTML in storage + update `schema_json`
- No drag-and-drop blocks in v1

---

## AI

- **Provider:** Anthropic Claude (existing `src/lib/claude.ts`)
- **Call 1 (generate):** prompt → `schema_json` (or clarifying questions if prompt is too vague)
- **Call 2 (build):** `schema_json` → full responsive HTML with `data-field` attrs, SEO tags, tracker placeholder
- Reuse `uploadHtml()` from `src/lib/storage.ts`

---

## Publish flow

Same as `POST /api/pages/from-html`:

1. Save `pages` row (`source_type: 'ai'`, `schema_json`, `html_url`, `html_content`)
2. Create `tests` + `test_variants` with `page_id` pointing to the page
3. Serve on client's custom domain via existing middleware → `/api/serve`
4. `tracker.js` injected automatically — same as all HTML variants today

**Inherited from existing platform (no new work):** form lead capture, Resend emails, HubSpot/Facebook/Google integrations — all work via `tracker.js` on served HTML pages.

---

## v1 scope

**Building in v1:**
- Prompt → generate → build → preview
- Inline text editing
- Publish on custom domain + tracking
- Page list, duplicate, delete
- Vertical selector (3 options)

**Deferred:**
- UTM personalization rules
- `pages.trysplitlab.com` subdomain

---

## Reference

- Existing paste-HTML flow: `src/app/api/pages/from-html/route.ts`
- Serve pipeline: `src/app/api/serve/route.ts` (section 6c)
- Storage helper: `src/lib/storage.ts`
- Co-dev's 34-task plan is a useful implementation checklist; follow this doc for architectural choices where they differ (especially hosting and schema approach).
