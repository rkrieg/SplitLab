-- getDeviceType() now returns 'unknown' instead of defaulting missing/absent
-- User-Agents to 'desktop' (see 039_events_device_type.sql) — that default
-- was silently mislabeling bot/scanner traffic as real desktop visitors.
alter table events
  drop constraint if exists events_device_type_check;

alter table events
  add constraint events_device_type_check
  check (device_type is null or device_type in ('mobile', 'desktop', 'unknown'));
