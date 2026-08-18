import type { BackupState, DatabaseConnection } from '@airaos/types';
import { providerCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import * as digitalocean from '../digitalocean/client.js';
import type { DoDatabaseCluster } from '../digitalocean/types.js';

/**
 * Database backup reporting (spec section 26 / 47).
 *
 * The governing rule: the console must not claim a backup exists unless it has
 * read something that says so. Everything here therefore starts from
 * `verified: false` and is only upgraded when a provider reports concrete
 * backup state.
 */

export function unverifiedBackupState(reason: string | null): BackupState {
  return {
    enabled: false,
    lastBackupAt: null,
    status: reason,
    retentionDays: null,
    target: null,
    verified: false,
  };
}

/**
 * Best-effort backup state for a registered connection.
 *
 * For DigitalOcean managed databases, the cluster list is matched by host so the
 * console can report the provider's own maintenance and backup configuration.
 * For self-hosted targets there is no API to ask, so the state stays unverified
 * with an explanation the UI shows verbatim.
 */
export async function unverifiedBackup(connection: DatabaseConnection): Promise<BackupState> {
  if (connection.provider !== 'digitalocean_managed') {
    return unverifiedBackupState(
      'Backup state is not exposed for this provider. Verify it in your backup tooling.',
    );
  }

  if (!(await digitalocean.isConfigured())) {
    return unverifiedBackupState('DigitalOcean is not configured, so backup state is unknown.');
  }

  try {
    const result = await providerCache.wrap(
      'do:database-clusters',
      120_000,
      async () =>
        digitalocean.listAll<DoDatabaseCluster>('/databases', 'databases', { perPage: 100 }),
      { fallbackToStale: true },
    );

    const cluster = result.value.find(
      (candidate) =>
        candidate.connection?.host === connection.host ||
        // Managed clusters expose a private host too; match on the id prefix
        // DigitalOcean embeds in the hostname as a fallback.
        connection.host.startsWith(candidate.id.slice(0, 8)),
    );

    if (!cluster) {
      return unverifiedBackupState(
        'No matching DigitalOcean managed cluster was found for this host.',
      );
    }

    const backups = await digitalocean
      .getRaw<{ backups: Array<{ created_at: string; size_gigabytes: number }> }>(
        `/databases/${encodeURIComponent(cluster.id)}/backups`,
      )
      .catch(() => null);

    const latest = backups?.backups
      ?.slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

    if (!latest) {
      return {
        enabled: true,
        lastBackupAt: null,
        status: 'Managed backups are enabled, but no completed backup was reported yet.',
        retentionDays: 7,
        target: 'DigitalOcean managed backups',
        verified: false,
      };
    }

    return {
      enabled: true,
      lastBackupAt: latest.created_at,
      status: 'Managed backup completed.',
      // DigitalOcean retains 7 days of daily backups on managed clusters.
      retentionDays: 7,
      target: 'DigitalOcean managed backups',
      verified: true,
    };
  } catch (error) {
    logger().debug({ err: error, connectionId: connection.id }, 'managed backup state unavailable');
    return unverifiedBackupState('DigitalOcean did not return backup state for this cluster.');
  }
}
