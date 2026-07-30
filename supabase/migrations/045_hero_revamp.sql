-- UTM Personalization V2 — hero section revamp scope expansion (2026-07-30).
-- See docs/utm-personalization-v2-automation.md, "Scope expansion — hero
-- section revamp" under PIVOT. Lets a rule replace the entire hero
-- container's HTML (content + layout + CTA together) instead of only
-- swapping individual field strings via overrides_json. A rule uses one or
-- the other — this column coexists with, and does not replace, overrides_json.

alter table personalization_rules add column if not exists hero_html text;
