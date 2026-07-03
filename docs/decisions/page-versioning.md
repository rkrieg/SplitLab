# Decision: AI Page Versioning

## Status
Deferred — revisit after core AI Pages feature ships.

## What we decided NOT to do (yet)
Store a version snapshot every time a user saves a draft or edits an AI-generated page.

Currently every follow-up edit **overwrites** the same HTML in Supabase Storage. The `conversation_json` column stores the chat history (prompts + assistant responses) but not HTML snapshots per turn.

## What versioning would look like

New table: `page_versions`

```sql
CREATE TABLE page_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  html_content  TEXT NOT NULL,
  schema_json   JSONB,
  version_num   INTEGER NOT NULL,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

Every save (follow-up edit or manual draft save) inserts a new row. UI shows a version history panel — user can preview and restore any version.

## Why deferred
- Adds storage cost (full HTML per version, pages can be large)
- Needs UI: version list panel, diff view, restore action
- `conversation_json` already gives partial history (what was asked, not the HTML result)
- Not blocking the core happy flow

## When to revisit
- When users ask "can I go back to how it looked before?"
- When auto-publish is live and users accidentally publish bad edits
- After usage data shows how many follow-up edits users typically make
