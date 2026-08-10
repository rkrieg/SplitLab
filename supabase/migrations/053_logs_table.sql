-- Structured app logs (AI calls, event-pipeline skips/rejections, Stripe
-- webhooks, domain verification). No retention/cleanup job yet — rows are
-- kept indefinitely for now, by design (see pg_cron cleanup discussion).
create table if not exists logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  category text not null check (category in ('ai_call', 'event_skip', 'stripe_webhook', 'domain_verification')),
  level text not null check (level in ('info', 'warn', 'error')),
  message text not null,
  metadata jsonb
);

create index if not exists idx_logs_created_at on logs(created_at);
create index if not exists idx_logs_category on logs(category);
