-- =============================================================================
-- 0001_settings — default operational policy. Safe to run in every environment;
-- existing values are preserved.
-- =============================================================================

INSERT INTO console_settings (key, value, description) VALUES
  ('inventory.cache_ttl_seconds', '45'::jsonb,
   'How long droplet / Proxmox inventory is served from cache.'),
  ('metrics.cache_ttl_seconds', '20'::jsonb,
   'How long provider metrics are served from cache.'),
  ('health.cache_ttl_seconds', '15'::jsonb,
   'How long application health probe results are served from cache.'),
  ('health.probe_timeout_ms', '4000'::jsonb,
   'Per-application health check timeout.'),
  ('database.production_read_only', 'true'::jsonb,
   'Production databases start read-only. Turning this off is not supported.'),
  ('database.write_window_minutes', '15'::jsonb,
   'Default lifetime of a database write window.'),
  ('database.max_result_rows', '1000'::jsonb,
   'Hard cap on rows returned to the SQL editor.'),
  ('database.statement_timeout_ms', '15000'::jsonb,
   'statement_timeout applied to every console-issued query.'),
  ('logs.retention_days', '14'::jsonb,
   'How long the log ingest buffer is kept before trimming.'),
  ('health_history.retention_days', '30'::jsonb,
   'How long per-application health check history is kept.'),
  ('deployments.require_production_approval', 'true'::jsonb,
   'Production deployments need a second authorised approver.'),
  ('alerts.auto_resolve_after_hours', '72'::jsonb,
   'Acknowledged alerts no longer firing are closed out after this long.')
ON CONFLICT (key) DO NOTHING;
