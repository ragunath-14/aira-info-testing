-- =============================================================================
-- 0002_demo_registry — sample application registry for local development.
--
-- Only loaded by `npm run seed -- --demo`, which refuses to run against a
-- production database. Nothing here grants access to real infrastructure: the
-- rows are registry metadata pointing at localhost.
-- =============================================================================

INSERT INTO applications
  (key, name, kind, environment, host, container_name, repository, branch,
   version, commit_sha, health_url, port, depends_on, owner_team, operations_enabled)
VALUES
  ('airaos-api', 'AIRAOS API', 'api', 'development', 'dev-vm-01', 'airaos-api',
   'airaos/airaos-api', 'develop', 'v2.4.2', 'def4567',
   'http://127.0.0.1:8080/health', 8080, ARRAY['airaos-postgres','airaos-redis'],
   'Platform', TRUE),
  ('airaos-web', 'AIRAOS Web', 'web', 'development', 'dev-vm-01', 'airaos-web',
   'airaos/airaos-web', 'develop', 'v2.4.2', 'def4567',
   'http://127.0.0.1:3002/health', 3002, ARRAY['airaos-api'],
   'Platform', TRUE),
  ('airaos-worker', 'AIRAOS Worker', 'worker', 'development', 'dev-vm-01', 'airaos-worker',
   'airaos/airaos-api', 'develop', 'v2.4.2', 'def4567',
   'http://127.0.0.1:8081/health', 8081, ARRAY['airaos-redis','airaos-postgres'],
   'Platform', TRUE),
  ('airaos-chatbot', 'Chatbot', 'service', 'development', 'dev-vm-02', 'airaos-chatbot',
   'airaos/chatbot', 'develop', 'v1.8.0', 'aa11bb2',
   'http://127.0.0.1:8090/health', 8090, ARRAY['airaos-api'],
   'Conversational', FALSE),
  ('commerce-os', 'Commerce OS', 'service', 'development', 'dev-vm-02', 'commerce-os',
   'airaos/commerce-os', 'develop', 'v0.9.4', 'cc33dd4',
   'http://127.0.0.1:8095/health', 8095, ARRAY['airaos-api','airaos-postgres'],
   'Commerce', FALSE),

  ('airaos-api', 'AIRAOS API', 'api', 'staging', 'staging-vm-01', 'airaos-api',
   'airaos/airaos-api', 'main', 'v2.4.1', 'abc1234',
   'http://10.10.20.11:8080/health', 8080, ARRAY['airaos-postgres','airaos-redis'],
   'Platform', TRUE),
  ('airaos-web', 'AIRAOS Web', 'web', 'staging', 'staging-vm-01', 'airaos-web',
   'airaos/airaos-web', 'main', 'v2.4.1', 'abc1234',
   'http://10.10.20.11:3002/health', 3002, ARRAY['airaos-api'],
   'Platform', TRUE),

  ('airaos-api', 'AIRAOS API', 'api', 'production', 'prod-droplet-01', 'airaos-api',
   'airaos/airaos-api', 'main', 'v2.4.1', 'abc1234',
   'http://10.20.30.11:8080/health', 8080, ARRAY['airaos-postgres','airaos-redis'],
   'Platform', TRUE),
  ('airaos-web', 'AIRAOS Web', 'web', 'production', 'prod-droplet-01', 'airaos-web',
   'airaos/airaos-web', 'main', 'v2.4.1', 'abc1234',
   'http://10.20.30.11:3002/health', 3002, ARRAY['airaos-api'],
   'Platform', TRUE),
  ('airaos-worker', 'AIRAOS Worker', 'worker', 'production', 'prod-droplet-02', 'airaos-worker',
   'airaos/airaos-api', 'main', 'v2.4.1', 'abc1234',
   'http://10.20.30.12:8081/health', 8081, ARRAY['airaos-redis','airaos-postgres'],
   'Platform', TRUE)
ON CONFLICT (key, environment) DO NOTHING;
