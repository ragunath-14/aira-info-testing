-- =============================================================================
-- 0001_init — identity, RBAC and session storage for the AIRAOS Infra Console.
--
-- The console mirrors AIRAOS identities rather than owning them: `users` rows
-- are created on first successful SSO login and keyed by `external_id`. Local
-- credentials exist only for development instances (see 0007_local_auth.sql).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- Case-insensitive email comparison; avoids duplicate identities differing only
-- by capitalisation.
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TYPE environment AS ENUM ('development', 'testing', 'staging', 'production');

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Subject claim from the AIRAOS identity provider. NULL for local dev users.
  external_id     TEXT UNIQUE,
  email           CITEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  -- Last MFA assertion we observed, used to enforce AUTH_REQUIRE_MFA.
  mfa_verified_at TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT NOT NULL,
  -- Environments any holder of this role may act in.
  environments environment[] NOT NULL DEFAULT '{}',
  is_system   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  key         TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_key       TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE user_roles (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key    TEXT NOT NULL REFERENCES roles(key) ON DELETE RESTRICT,
  granted_by  UUID REFERENCES users(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_key)
);

CREATE INDEX user_roles_role_idx ON user_roles (role_key);

CREATE TABLE sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only a hash of the session token is stored; the raw token lives in the
  -- operator's cookie and nowhere else.
  token_hash     TEXT NOT NULL UNIQUE,
  mfa_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  ip_address     INET,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
