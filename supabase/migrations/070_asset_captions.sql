-- One-line AI descriptions of link-imported images, cached by source ref.
--
-- Captioning is what lets the model choose from a whole folder instead of the
-- handful it could afford to look at. Cached globally by source_ref so pasting
-- the same folder again costs nothing and returns instantly.
create table if not exists asset_captions (
  source_ref  text primary key,
  caption     text not null,
  kind        text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_asset_captions_created_at on asset_captions(created_at);

-- ── Ledger ──────────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('070', 'asset_captions')
ON CONFLICT (version) DO NOTHING;
