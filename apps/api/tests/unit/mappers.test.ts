import { describe, expect, it } from 'vitest';
import { environmentFromTags, mapDroplet, mapDropletBackupState, mapCpuPercent } from '../../src/providers/digitalocean/mapper.js';
import {
  backupStateFromTasks,
  environmentFromGuest,
  ipsFromAgent,
  ipsFromLxcConfig,
  mapGuest,
} from '../../src/providers/proxmox/mapper.js';
import { escapeTarget } from '../../src/providers/prometheus/presets.js';
import type { DoDroplet } from '../../src/providers/digitalocean/types.js';
import type { PveGuestSummary } from '../../src/providers/proxmox/types.js';

/**
 * Provider mapper tests. The environment-resolution cases matter most: an
 * incorrectly mapped environment would apply the wrong guardrails (rule 12).
 */

describe('DigitalOcean environmentFromTags', () => {
  it('reads an env: prefixed tag', () => {
    expect(environmentFromTags(['web', 'env:staging'])).toBe('staging');
  });

  it('reads a bare environment tag', () => {
    expect(environmentFromTags(['development'])).toBe('development');
  });

  it('accepts common shorthands', () => {
    expect(environmentFromTags(['prod'])).toBe('production');
    expect(environmentFromTags(['stg'])).toBe('staging');
    expect(environmentFromTags(['qa'])).toBe('testing');
    expect(environmentFromTags(['dev'])).toBe('development');
  });

  it('is case-insensitive', () => {
    expect(environmentFromTags(['ENV:Production'])).toBe('production');
  });

  it('defaults an untagged resource to production, the strictest guardrail', () => {
    // Deliberate: an unlabelled resource must not inherit loose rules.
    expect(environmentFromTags([])).toBe('production');
    expect(environmentFromTags(['web', 'nginx'])).toBe('production');
  });
});

function dropletFixture(overrides: Partial<DoDroplet> = {}): DoDroplet {
  return {
    id: 12345,
    name: 'prod-droplet-01',
    memory: 4096,
    vcpus: 2,
    disk: 80,
    locked: false,
    status: 'active',
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
    features: ['monitoring', 'backups'],
    backup_ids: [1],
    next_backup_window: null,
    snapshot_ids: [],
    image: { id: 1, name: 'Ubuntu 24.04', distribution: 'Ubuntu', slug: null, type: 'base' },
    size: {
      slug: 's-2vcpu-4gb',
      memory: 4096,
      vcpus: 2,
      disk: 80,
      price_monthly: 24,
      price_hourly: 0.036,
      available: true,
      description: 'Basic',
    },
    size_slug: 's-2vcpu-4gb',
    networks: {
      v4: [
        { ip_address: '203.0.113.10', netmask: '255.255.240.0', gateway: '203.0.113.1', type: 'public' },
        { ip_address: '10.10.0.5', netmask: '255.255.0.0', gateway: '10.10.0.1', type: 'private' },
      ],
      v6: [],
    },
    region: { slug: 'blr1', name: 'Bangalore 1', available: true, sizes: [], features: [] },
    tags: ['env:production'],
    vpc_uuid: 'vpc-1',
    ...overrides,
  };
}

describe('mapDroplet', () => {
  it('maps the fields the console displays', () => {
    const droplet = mapDroplet(dropletFixture());
    expect(droplet.id).toBe('12345');
    expect(droplet.environment).toBe('production');
    expect(droplet.networks.publicIpv4).toBe('203.0.113.10');
    expect(droplet.networks.privateIpv4).toBe('10.10.0.5');
    expect(droplet.networks.ipv6).toBeNull();
    expect(droplet.monitoringEnabled).toBe(true);
    expect(droplet.ageSeconds).toBeGreaterThan(86_000);
  });

  it('tolerates a droplet with no networks', () => {
    const droplet = mapDroplet(dropletFixture({ networks: { v4: [], v6: [] } }));
    expect(droplet.networks.publicIpv4).toBeNull();
  });

  it('maps an unexpected status to unknown rather than guessing', () => {
    const droplet = mapDroplet(dropletFixture({ status: 'hibernating' as DoDroplet['status'] }));
    expect(droplet.status).toBe('unknown');
  });
});

describe('mapDropletBackupState', () => {
  it('marks backups verified only when a backup id exists', () => {
    expect(mapDropletBackupState(dropletFixture()).verified).toBe(true);
    expect(mapDropletBackupState(dropletFixture({ backup_ids: [] })).verified).toBe(false);
  });

  it('reports disabled when the feature is absent', () => {
    const state = mapDropletBackupState(dropletFixture({ features: [], backup_ids: [] }));
    expect(state.enabled).toBe(false);
    expect(state.status).toBe('disabled');
    expect(state.verified).toBe(false);
  });
});

describe('mapCpuPercent', () => {
  it('derives a busy percentage from cumulative counters', () => {
    const series = mapCpuPercent({
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [
          { metric: { mode: 'idle' }, values: [[1000, '100'], [1060, '130']] },
          { metric: { mode: 'user' }, values: [[1000, '100'], [1060, '170']] },
        ],
      },
    });

    // Total delta 100, idle delta 30 → 70% busy.
    expect(series).toHaveLength(1);
    expect(series[0]?.v).toBeCloseTo(70, 1);
  });

  it('returns an empty series rather than inventing data', () => {
    expect(mapCpuPercent(null)).toEqual([]);
    expect(mapCpuPercent({ status: 'success', data: { resultType: 'matrix', result: [] } })).toEqual([]);
  });
});

describe('Proxmox environmentFromGuest', () => {
  it('prefers a tag over the name', () => {
    expect(environmentFromGuest('env:staging', 'prod-db-01')).toBe('staging');
  });

  it('handles semicolon-separated Proxmox tags', () => {
    expect(environmentFromGuest('web;testing;linux', 'guest')).toBe('testing');
  });

  it('falls back to a naming convention', () => {
    expect(environmentFromGuest(undefined, 'staging-api-01')).toBe('staging');
    expect(environmentFromGuest('', 'dev-vm-02')).toBe('development');
    expect(environmentFromGuest('', 'qa-runner')).toBe('testing');
  });

  it('defaults to production when nothing resolves', () => {
    expect(environmentFromGuest(undefined, 'vm-100')).toBe('production');
  });

  it('does not match an environment word inside another word', () => {
    // "devops" should not read as development.
    expect(environmentFromGuest(undefined, 'devops-tools')).toBe('development');
  });
});

describe('mapGuest', () => {
  const summary: PveGuestSummary = {
    vmid: 101,
    name: 'staging-api-01',
    status: 'running',
    node: 'pve-01',
    cpu: 0.234,
    cpus: 4,
    mem: 2_147_483_648,
    maxmem: 4_294_967_296,
    disk: 10_737_418_240,
    maxdisk: 53_687_091_200,
    uptime: 7200,
    tags: 'env:staging;api',
    type: 'qemu',
  };

  it('converts the CPU fraction to a percentage', () => {
    expect(mapGuest(summary, 'pve-01', 'qemu').cpuPercent).toBeCloseTo(23.4, 1);
  });

  it('splits tags and resolves the environment', () => {
    const guest = mapGuest(summary, 'pve-01', 'qemu');
    expect(guest.tags).toEqual(['env:staging', 'api']);
    expect(guest.environment).toBe('staging');
  });

  it('starts with an unverified backup state', () => {
    expect(mapGuest(summary, 'pve-01', 'qemu').backup.verified).toBe(false);
  });

  it('synthesises a name when Proxmox reports none', () => {
    const guest = mapGuest({ ...summary, name: undefined }, 'pve-01', 'lxc');
    expect(guest.name).toBe('lxc-101');
  });
});

describe('backupStateFromTasks', () => {
  it('marks verified only for a task that completed OK', () => {
    const state = backupStateFromTasks(
      101,
      [
        {
          upid: 'UPID:pve-01:0001:101:vzdump',
          node: 'pve-01',
          type: 'vzdump',
          id: '101',
          starttime: 1_700_000_000,
          endtime: 1_700_000_600,
          exitstatus: 'OK',
        },
      ],
      'backup-nfs',
    );
    expect(state.verified).toBe(true);
    expect(state.target).toBe('backup-nfs');
    expect(state.lastBackupAt).not.toBeNull();
  });

  it('does not mark verified for a failed task', () => {
    const state = backupStateFromTasks(
      101,
      [
        {
          upid: 'UPID:pve-01:0001:101:vzdump',
          node: 'pve-01',
          type: 'vzdump',
          id: '101',
          starttime: 1_700_000_000,
          endtime: 1_700_000_600,
          exitstatus: 'job failed',
        },
      ],
      null,
    );
    expect(state.verified).toBe(false);
    expect(state.status).toBe('job failed');
  });

  it('returns an unverified state when no task matches the guest', () => {
    expect(backupStateFromTasks(999, [], null).verified).toBe(false);
  });
});

describe('Proxmox address extraction', () => {
  it('reads addresses from the QEMU guest agent, skipping loopback and link-local', () => {
    const addresses = ipsFromAgent({
      result: [
        { name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4', prefix: 8 }] },
        {
          name: 'eth0',
          'ip-addresses': [
            { 'ip-address': '10.10.20.11', 'ip-address-type': 'ipv4', prefix: 24 },
            { 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6', prefix: 64 },
          ],
        },
      ],
    });
    expect(addresses).toEqual(['10.10.20.11']);
  });

  it('returns nothing when the agent is unavailable', () => {
    expect(ipsFromAgent(null)).toEqual([]);
  });

  it('reads a static LXC address and skips DHCP', () => {
    expect(
      ipsFromLxcConfig({ net0: 'name=eth0,bridge=vmbr0,ip=10.10.30.5/24', net1: 'name=eth1,ip=dhcp' }),
    ).toEqual(['10.10.30.5']);
  });
});

describe('Prometheus escapeTarget', () => {
  it('escapes regex metacharacters so a target cannot widen the query', () => {
    expect(escapeTarget('10.0.0.1:9100')).toBe('10\\.0\\.0\\.1:9100');
    expect(escapeTarget('a.*')).toBe('a\\.\\*');
  });

  it('treats an empty or wildcard target as match-all', () => {
    expect(escapeTarget(undefined)).toBe('.+');
    expect(escapeTarget('')).toBe('.+');
    expect(escapeTarget('*')).toBe('.+');
  });
});
