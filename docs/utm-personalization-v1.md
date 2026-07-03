# UTM Personalization — Implementation Plan

## Architecture Decision (V3 — Dynamic Fields)

**Fully dynamic element-to-field mapping.** Users define their own field names by clicking any text, button, heading, or image element in the iframe preview. No hardcoded fields.

- **AI-generated pages** — 4 default fields pre-seeded (headline, subhead, cta_text, hero_image) from `data-field` attributes. User can add more custom fields.
- **Uploaded HTML pages** — Start empty. User clicks elements, names each field. Auto-CSS-selector generation via postMessage.

Both page types use the same Element Picker UI at `/clients/[id]/ai-pages/[pageId]/utm`.

`field_selectors_json` on the `pages` table stores `{ [key]: { selector, type, label } }` — dynamic, arbitrary keys.

The swap script at serve time loops all `overrides_json` keys dynamically, looks up selector + type from `field_selectors_json`, swaps `textContent` for text fields and `src` for image fields.

---

## ✅ Completed

### Database
- Migration `030_utm_personalization_rules.sql` — `personalization_rules` table with `page_id`, `match_param`, `match_value`, `is_fallback`, `overrides_json`, `priority`
- Migration `031_utm_selector_column.sql` — `field_selectors_json jsonb` column on `pages`

### API Routes
- `GET /api/pages/[id]/personalization-rules` — returns all rules ordered by priority
- `POST /api/pages/[id]/personalization-rules` — full replace
- `GET /api/pages/[id]/field-selectors` — returns stored `{ key: { selector, type, label } }` map
- `PATCH /api/pages/[id]/field-selectors` — saves dynamic field mappings; validates keys as `[a-z0-9_]{1,50}`; accepts any number of fields; stores `{ selector, type: 'text'|'image', label }`
- `POST /api/pages/[id]/suggest-headlines` — AI headline suggestions via claude-haiku

### Serve Routes
- Both `src/app/api/serve/route.ts` and `src/app/pages/[slug]/route.ts` inject a fully dynamic swap script
- Script loops all `overrides_json` keys, resolves selector from `field_selectors_json` (with AI `data-field` fallback for old keys), swaps `src` for images, `textContent` for text
- Backward compatible: keys without a stored selector fall back to hardcoded `data-field` defaults

### Element Picker Page — `/clients/[id]/ai-pages/[pageId]/utm`
- **Left sidebar:**
  - **Map Elements** section — dynamic field list; "Add Field" button → type label → enters pick mode; click element in iframe → selector auto-generated via postMessage; element type (text/image) detected from `tagName === 'IMG'`; AI pages show Pick button only for custom fields added beyond defaults
  - **UTM Rules** section — Add Rule / Save buttons; each rule card: When `utm_param = value` + one input per mapped field (URL input for image fields, text input for text); Default fallback card; AI suggest sparkles on `headline` field if present
- **Right:** iframe preview + UTM simulator dropdown (appends `?param=value` to preview src)

### AI Builder
- UTM panel removed from `AIBuilderClient`
- "UTM" button in toolbar links to `/utm` page
- "Set Up UTM" button added per row in `AIPagesClient`

---

## Types

```ts
// overrides_json is now fully dynamic
interface UTMRule {
  overrides_json: Record<string, string>;
}

// field_selectors_json shape
type StoredFieldSelectors = Record<string, {
  selector: string;
  type: 'text' | 'image';
  label: string;
}>;
```

---

## Still Pending

- **Apply migrations** — `030` and `031` need `supabase db push` against the actual database
- **Re-upload warning** — when user re-uploads HTML to a page that already has personalization_rules, show a blocking warning modal
- **UTM picker for non-AI pages** — route only exists under `/ai-pages/`. HTML-upload pages need the same button wired up wherever they're managed

---

## Edge Cases

- **Selector not found at runtime** — `querySelector` returns null, guarded by `if(!el)return`, silent skip
- **DB error on rules query** — try/catch, serve page without UTM, never block delivery
- **Duplicate field keys** — `labelToKey()` auto-suffixes `_2`, `_3` if key already exists
- **Image fields** — swap `el.src`, also handles `el.tagName === 'IMG'` runtime detection as fallback even if type stored wrong
- **match_type** — exact match only; `contains` not in scope
