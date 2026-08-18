-- =============================================================================
-- 0003_providers_resources — provider registrations and the resource inventory
-- cache. Provider credentials are stored as ciphertext produced by the API's
-- AES-256-GCM envelope (see apps/api/src/security/crypto.ts); the plaintext
-- never touches this database.
-- =============================================================================

CREATE TYPE provider_kind AS ENUM (
  'digitalocean',
  'proxmox',
  'prometheus',
  'alertmanager',
  'grafana',
  'redis',
  'postgres'
);

CREATE TABLE providers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         provider_kind NOT NULL,
  name         TEXT NOT NULL,
  -- Non-secret connection settings (base URL, region hints, TLS options).
  settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Envelope-encrypted secret bundle: { v, iv, tag, ciphertext }.
  secret_cipher JSONB,
  -- Where the secret actually lives when an external manager is in use.
  secret_ref   TEXT,
  is_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  last_success_at TIMESTAMPTZ,
  last_error_at   TIMESTAMPTZ,
  last_error_code TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);

CREATE TRIGGER providers_updated_at BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Inventory cache. Authoritative state always lives with the provider; this
-- table exists so the UI can show last-known-good data during an outage and so
-- environment tagging survives provider restarts.
CREATE TABLE infra_resources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_kind provider_kind NOT NULL,
  -- Provider-native identifier (droplet id, "node/vmid", connection uuid).
  external_id   TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  name          TEXT NOT NULL,
  environment   environment NOT NULL,
  -- Last snapshot of the mapped resource, as returned to the UI.
  snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT,
  -- Explicit operator override; takes precedence over tag-derived environment.
  environment_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_kind, external_id)
);

CREATE INDEX infra_resources_env_idx ON infra_resources (environment, provider_kind);
CREATE INDEX infra_resources_kind_idx ON infra_resources (resource_kind);

CREATE TRIGGER infra_resources_updated_at BEFORE UPDATE ON infra_resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
