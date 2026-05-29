## How Lead Capture Works

### Core Concept
- `tracker.js` intercepts button clicks **before** the page's own JS runs (using capture phase)
- Reads all filled input values at that moment
- POSTs data to `/api/leads` — **no HTML changes needed**

---

### Works Across All Modes

| Mode | Lead Capture | Condition |
|---|---|---|
| HTML variant | ✅ | Always |
| AI/Hosted variant | ✅ | Always |
| Redirect (302) | ✅ | Requires `tracker.js` on external page |
| Proxy/iframe | ✅ | Requires `tracker.js` on external page |

> If conversions already work → `tracker.js` is installed → leads will work automatically

---

### Two Form Scenarios

- **Actual `<form>` tag** → `submit` event fires → `FormData(form)` captures all fields ✅
- **No `<form>`, just inputs + button** → button click → scans all visible inputs → reads current values ✅

---

### Field Key Priority
- `name` attribute → `placeholder` → `type` → `field_N`

### Always Skipped
- `type="password"`
- `type="hidden"`
- `type="file"`
- Empty values

---

### Lead Record Output
```json
{
  "email": "john@gmail.com",
  "name": "John Smith",
  "utm_source": "facebook",
  "utm_campaign": "summer_sale",
  "variant": "Variant B"
}
```

---

### TODOs
- DB migration — new `leads` table (`test_id`, `variant_id`, `visitor_hash`, `form_data` JSONB, `utm_data` JSONB, `created_at`)
- `tracker.js` — on form submit/button click, serialize fields + UTMs → POST to `/api/leads`
- `tracking.ts` — same capture logic for HTML/AI hosted variants
- `/api/leads/route.ts` — new POST endpoint to store lead
- `/api/tests/[id]/leads/route.ts` — query leads table
- `AnalyticsClient.tsx` — dynamic columns from `form_data` keys + UTM columns
- `AnalyticsClient.tsx` — add note for redirect/proxy: *"requires tracker.js on destination page"*