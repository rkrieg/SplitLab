-- Add field_selectors_json to pages table.
-- Maps logical field names to CSS selectors for the UTM Element Picker.
-- AI pages: selectors auto-derived from data-field attributes (not stored here).
-- Uploaded HTML pages: { "headline": "#el-a3f2", "subhead": ".intro", "cta_text": "a.btn" }
-- NULL means use default data-field selectors (AI pages).
alter table pages
  add column if not exists field_selectors_json jsonb;
