-- Migration ledger.
--
-- Until now nothing recorded which migrations had been run: they were pasted into
-- the Supabase SQL editor by hand, by more than one person, and the only way to
-- answer "is 057 applied?" was to inspect the schema and infer it
-- (see scripts/check-migrations.mjs, which does exactly that).
--
-- This creates the table the Supabase CLI uses for the same purpose, so from here on
-- the answer is one query. The shape and name match the CLI's own bootstrap, so
-- `supabase migration list` / `db push` will read and write this table if the project
-- is ever linked to the CLI. `applied_at` is an extra column for auditing; the CLI
-- inserts by explicit column name, so it is free to ignore it.
--
-- The backfilled rows below are the 59 migrations in this folder, all verified as
-- already applied on 2026-08-27 by scripts/check-migrations.mjs (schema fingerprinting
-- plus live function/constraint definition comparison) against BOTH the staging and
-- production databases. So this file is identical for both — run it as-is on each.
--
-- 042-047 are deliberately absent. They exist only on origin/development /
-- origin/revision-utm-automation (the UTM auto-detection feature), that branch has been
-- abandoned, and the files will never enter this folder. Their objects are live in
-- staging only; see docs/schema-drift-staging-vs-prod.md. There is no 049 either — that
-- number was never used.

CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version    text PRIMARY KEY,
  name       text,
  statements text[],
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill. ON CONFLICT DO NOTHING so this is safe to re-run, and so it will not
-- clobber rows if the CLI has already claimed some of these versions.
-- statements is left NULL: these were applied by hand, so the exact statement text
-- that ran is not recoverable, and inventing it would be worse than recording nothing.
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('001', 'initial_schema'),
  ('002', 'variant_redirect_url'),
  ('003', 'variant_tracking_verified'),
  ('004', 'head_scripts'),
  ('005', 'ai_variant_scraper'),
  ('006', 'domain_vercel_verification'),
  ('007', 'add_owner_id_to_clients'),
  ('008', 'add_test_id_to_scripts'),
  ('009', 'pages_soft_delete'),
  ('010', 'add_plan_to_users'),
  ('011', 'stripe_billing'),
  ('012', 'scan_results'),
  ('013', 'add_current_period_end'),
  ('014', 'password_resets'),
  ('015', 'direct_db_additions'),
  ('016', 'visitor_usage'),
  ('017', 'users_visitor_warning'),
  ('018', 'form_leads'),
  ('019', 'integrations'),
  ('020', 'integration_token_refresh'),
  ('021', 'test_integration_mappings'),
  ('022', 'variant_form_fields'),
  ('023', 'webhook_multi_per_workspace'),
  ('024', 'goal_variant_scope'),
  ('025', 'drop_legacy_ai_variant_tables'),
  ('026', 'affiliate_program'),
  ('027', 'form_leads_fbclid'),
  ('028', 'ai_page_builder'),
  ('029', 'fix_pages_constraints'),
  ('030', 'ai_pages_cleanup'),
  ('031', 'nullable_html_url'),
  ('032', 'utm_personalization_rules'),
  ('033', 'utm_selector_column'),
  ('034', 'utm_multi_condition_rules'),
  ('035', 'form_leads_page_url'),
  ('036', 'form_leads_extra_params'),
  ('037', 'test_variant_stats_rpc'),
  ('038', 'test_variant_daily_stats_rpc'),
  ('039', 'events_device_type'),
  ('040', 'test_variant_device_stats_rpc'),
  ('041', 'page_drafts'),
  -- no 042-047: abandoned development branch, files never merged here
  ('048', 'add_growth_plan'),
  -- no 049
  ('050', 'pending_invites'),
  ('051', 'variant_duplicated_from'),
  ('052', 'events_device_type_unknown'),
  ('053', 'logs_table'),
  ('054', 'variant_archive'),
  ('055', 'ai_usage_metering'),
  ('056', 'hubspot_dynamic_fields'),
  ('057', 'ai_credit_topups'),
  ('058', 'mcp_oauth'),
  ('059', 'mcp_audit_log'),
  ('060', 'variant_speed_scores'),
  ('061', 'variant_clarity_share_url'),
  ('062', 'test_ai_insights'),
  ('063', 'test_forward_url_params'),
  ('064', 'page_skills_and_style'),
  ('065', 'client_leads_api'),
  ('066', 'migration_ledger')
ON CONFLICT (version) DO NOTHING;
