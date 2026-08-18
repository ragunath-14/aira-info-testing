import { beforeAll, describe, expect, it } from 'vitest';
import {
  CONNECTION_TYPES,
  CONNECTION_TYPE_PRESENTATION,
  isConnectionType,
} from '@airaos/types';
import {
  createConnectionSchema,
  digitalOceanConnectionSchema,
  grafanaConnectionSchema,
  postgresConnectionSchema,
  prometheusConnectionSchema,
  proxmoxConnectionSchema,
  redisConnectionSchema,
  updateConnectionSchema,
} from '@airaos/validation';

/**
 * Connection Manager tests.
 *
 * Focused on the two things that would be expensive to get wrong: the per-type
 * schemas (they are the only guard between a form and a provider adapter), and
 * the credential envelope binding.
 */

let crypto: typeof import('../../src/security/crypto.js');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
  process.env.AUDIT_LOG_SECRET = 'connections-audit-secret-0123456789';
  process.env.SESSION_SECRET = 'connections-session-secret-0123456789-abcd';
  process.env.LOCAL_AUTH_ENABLED = 'true';

  crypto = await import('../../src/security/crypto.js');
});

const base = { name: 'Test', environment: 'staging' as const };

describe('connection type catalogue', () => {
  it('has presentation for every type', () => {
    for (const type of CONNECTION_TYPES) {
      expect(CONNECTION_TYPE_PRESENTATION[type]?.label).toBeTruthy();
      expect(CONNECTION_TYPE_PRESENTATION[type]?.transport).toBeTruthy();
    }
  });

  it('does not include ssh — every system uses its native protocol', () => {
    expect(CONNECTION_TYPES).not.toContain('ssh' as never);
  });

  it('guards unknown types', () => {
    expect(isConnectionType('digitalocean')).toBe(true);
    expect(isConnectionType('ssh')).toBe(false);
    expect(isConnectionType(null)).toBe(false);
  });
});

describe('digitalocean schema', () => {
  it('accepts a read token and defaults the API URL', () => {
    const result = digitalOceanConnectionSchema.parse({
      ...base,
      type: 'digitalocean',
      apiToken: 'dop_v1_' + 'a'.repeat(30),
    });
    expect(result.apiUrl).toBe('https://api.digitalocean.com/v2');
  });

  it('rejects a token that is obviously too short to be real', () => {
    expect(() =>
      digitalOceanConnectionSchema.parse({ ...base, type: 'digitalocean', apiToken: 'short' }),
    ).toThrow();
  });

  it('treats the write token as optional', () => {
    const result = digitalOceanConnectionSchema.parse({
      ...base,
      type: 'digitalocean',
      apiToken: 'x'.repeat(30),
    });
    expect(result.writeApiToken).toBeUndefined();
  });
});

describe('proxmox schema', () => {
  const valid = {
    ...base,
    type: 'proxmox' as const,
    apiUrl: 'https://proxmox.internal:8006/api2/json',
    tokenId: 'console@pve!infra',
    tokenSecret: 'abcd1234-5678-90ef-ghij-klmnopqrstuv',
  };

  it('accepts a full token id', () => {
    expect(proxmoxConnectionSchema.parse(valid).tokenId).toBe('console@pve!infra');
  });

  it('rejects a bare token name without user@realm', () => {
    expect(() => proxmoxConnectionSchema.parse({ ...valid, tokenId: 'infra' })).toThrow();
  });

  it('rejects a non-URL api endpoint', () => {
    expect(() => proxmoxConnectionSchema.parse({ ...valid, apiUrl: 'proxmox.internal' })).toThrow();
  });

  it('defaults TLS verification on', () => {
    expect(proxmoxConnectionSchema.parse(valid).rejectUnauthorized).toBe(true);
  });

  it('refuses to disable TLS verification without a CA path', () => {
    // An unverified session to the thing controlling your VMs must be explicit.
    expect(() =>
      proxmoxConnectionSchema.parse({ ...valid, rejectUnauthorized: false }),
    ).toThrow(/CA certificate/i);
  });

  it('allows disabled verification when a CA path is supplied', () => {
    const result = proxmoxConnectionSchema.parse({
      ...valid,
      rejectUnauthorized: false,
      caCertPath: '/etc/ssl/certs/proxmox-ca.pem',
    });
    expect(result.caCertPath).toBe('/etc/ssl/certs/proxmox-ca.pem');
  });
});

describe('postgres schema', () => {
  const valid = {
    type: 'postgres' as const,
    name: 'Prod',
    environment: 'production' as const,
    host: 'db.internal',
    database: 'airaos',
    username: 'console_ro',
    password: 'secret',
  };

  it('defaults port and ssl mode', () => {
    const result = postgresConnectionSchema.parse(valid);
    expect(result.port).toBe(5432);
    expect(result.sslMode).toBe('require');
  });

  it('refuses to disable TLS on a production connection', () => {
    expect(() => postgresConnectionSchema.parse({ ...valid, sslMode: 'disable' })).toThrow(
      /must not disable TLS/i,
    );
  });

  it('allows disabled TLS outside production', () => {
    const result = postgresConnectionSchema.parse({
      ...valid,
      environment: 'development',
      sslMode: 'disable',
    });
    expect(result.sslMode).toBe('disable');
  });

  it('rejects a hostname with a shell metacharacter', () => {
    expect(() => postgresConnectionSchema.parse({ ...valid, host: 'db.internal; rm -rf /' })).toThrow();
  });
});

describe('redis schema', () => {
  it('treats the password as optional and defaults the rest', () => {
    const result = redisConnectionSchema.parse({
      ...base,
      type: 'redis',
      host: 'cache.internal',
    });
    expect(result.port).toBe(6379);
    expect(result.tls).toBe(false);
    expect(result.db).toBe(0);
  });

  it('bounds the database index to Redis defaults', () => {
    expect(() =>
      redisConnectionSchema.parse({ ...base, type: 'redis', host: 'cache', db: 99 }),
    ).toThrow();
  });
});

describe('prometheus schema', () => {
  it('accepts a URL with no credentials', () => {
    const result = prometheusConnectionSchema.parse({
      ...base,
      type: 'prometheus',
      url: 'http://prometheus:9090',
    });
    expect(result.url).toBe('http://prometheus:9090');
  });

  it('requires a password when a username is set', () => {
    expect(() =>
      prometheusConnectionSchema.parse({
        ...base,
        type: 'prometheus',
        url: 'http://prometheus:9090',
        username: 'admin',
      }),
    ).toThrow(/password is required/i);
  });
});

describe('grafana schema', () => {
  it('accepts a URL with no token, since deep links need none', () => {
    const result = grafanaConnectionSchema.parse({
      ...base,
      type: 'grafana',
      url: 'https://grafana.airaos.example',
    });
    expect(result.apiToken).toBeUndefined();
  });
});

describe('the discriminated union', () => {
  it('routes by type', () => {
    const result = createConnectionSchema.parse({
      ...base,
      type: 'redis',
      host: 'cache.internal',
    });
    expect(result.type).toBe('redis');
  });

  it('rejects a payload whose fields do not match its type', () => {
    // Proxmox fields under a redis discriminator must not validate.
    expect(() =>
      createConnectionSchema.parse({ ...base, type: 'proxmox', host: 'cache.internal' }),
    ).toThrow();
  });

  it('rejects an unknown type outright', () => {
    expect(() => createConnectionSchema.parse({ ...base, type: 'ssh', host: 'x' })).toThrow();
  });

  it('allows a partial update but still pins the type', () => {
    const result = updateConnectionSchema.parse({ type: 'redis', port: 6380 });
    expect(result.port).toBe(6380);
    expect(() => updateConnectionSchema.parse({ port: 6380 })).toThrow();
  });
});

describe('credential envelope binding', () => {
  it('binds a sealed credential to its own connection id', () => {
    const secrets = JSON.stringify({ apiToken: 'dop_v1_secret' });
    const sealed = crypto.seal(secrets, crypto.aad.connection('conn-1'));

    expect(crypto.open(sealed, crypto.aad.connection('conn-1'))).toBe(secrets);
    // A stolen blob cannot be pasted into another connection row to redirect the
    // console at a different host.
    expect(() => crypto.open(sealed, crypto.aad.connection('conn-2'))).toThrow();
  });

  it('keeps the connection AAD distinct from the database-connection AAD', () => {
    const sealed = crypto.seal('x', crypto.aad.connection('same-id'));
    expect(() => crypto.open(sealed, crypto.aad.databaseConnection('same-id'))).toThrow();
  });

  it('does not leak the plaintext into the envelope', () => {
    const sealed = crypto.seal(
      JSON.stringify({ tokenSecret: 'super-secret-value' }),
      crypto.aad.connection('conn-1'),
    );
    expect(JSON.stringify(sealed)).not.toContain('super-secret-value');
  });
});
