-- Device type (mobile/desktop) captured server-side from the request's
-- user-agent header at insert time. Nullable because historical rows have
-- no device info — they simply don't count toward either bucket.
alter table events
  add column if not exists device_type text
  check (device_type is null or device_type in ('mobile', 'desktop'));

create index if not exists idx_events_device_type on events(device_type);
