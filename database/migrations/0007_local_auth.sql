-- =============================================================================
-- 0007_local_auth — development-only credential store.
--
-- This table exists so a developer can run the console without a live AIRAOS
-- identity provider. The API refuses to consult it when NODE_ENV=production and
-- loadConfig() refuses to boot with LOCAL_AUTH_ENABLED=true there, so the table
-- being present in a production database is inert rather than a bypass.
-- =============================================================================

CREATE TABLE local_credentials (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- scrypt (N=16384, r=8, p=1) as "scrypt$<salt-b64>$<hash-b64>".
  password_hash TEXT NOT NULL,
  must_change   BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER local_credentials_updated_at BEFORE UPDATE ON local_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE local_credentials IS
  'Development fallback authentication. Never consulted when NODE_ENV=production.';
