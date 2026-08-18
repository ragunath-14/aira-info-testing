import type { MetricSummary } from '@airaos/types';

/**
 * PromQL preset catalogue (spec section 13).
 *
 * The browser never sends PromQL: it names a preset and an optional target
 * label, and the server builds the query. That keeps arbitrary expressions —
 * which can read any series in the TSDB and are trivially expensive — out of
 * reach of the UI.
 *
 * `$target` is substituted with a label-matcher-escaped value.
 */
export interface MetricPreset {
  key: string;
  label: string;
  unit: MetricSummary['unit'];
  /** PromQL with an optional `$target` placeholder. */
  expr: string;
  /** Label used for the target selector, for documentation and error messages. */
  targetLabel: 'instance' | 'job' | 'name' | 'datname' | 'none';
  warnAbove: number | null;
  criticalAbove: number | null;
}

const NODE_TARGET = '{instance=~"$target"}';

export const METRIC_PRESETS: Record<string, MetricPreset> = {
  node_cpu: {
    key: 'node_cpu',
    label: 'CPU utilisation',
    unit: 'percent',
    expr: `100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle",instance=~"$target"}[5m])) * 100)`,
    targetLabel: 'instance',
    warnAbove: 80,
    criticalAbove: 92,
  },
  node_memory: {
    key: 'node_memory',
    label: 'Memory used',
    unit: 'percent',
    expr: `100 * (1 - (node_memory_MemAvailable_bytes${NODE_TARGET} / node_memory_MemTotal_bytes${NODE_TARGET}))`,
    targetLabel: 'instance',
    warnAbove: 85,
    criticalAbove: 94,
  },
  node_disk: {
    key: 'node_disk',
    label: 'Root filesystem used',
    unit: 'percent',
    expr: `100 * (1 - (node_filesystem_avail_bytes{mountpoint="/",fstype!="tmpfs",instance=~"$target"} / node_filesystem_size_bytes{mountpoint="/",fstype!="tmpfs",instance=~"$target"}))`,
    targetLabel: 'instance',
    warnAbove: 80,
    criticalAbove: 90,
  },
  node_filesystem: {
    key: 'node_filesystem',
    label: 'Filesystem used (all mounts)',
    unit: 'percent',
    expr: `100 * (1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay",instance=~"$target"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay",instance=~"$target"}))`,
    targetLabel: 'instance',
    warnAbove: 80,
    criticalAbove: 90,
  },
  node_load: {
    key: 'node_load',
    label: 'Load average (1m per core)',
    unit: 'ratio',
    expr: `node_load1${NODE_TARGET} / on (instance) count by (instance) (node_cpu_seconds_total{mode="idle",instance=~"$target"})`,
    targetLabel: 'instance',
    warnAbove: 1,
    criticalAbove: 2,
  },
  node_network: {
    key: 'node_network',
    label: 'Network throughput',
    unit: 'bytes',
    expr: `sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*",instance=~"$target"}[5m]))`,
    targetLabel: 'instance',
    warnAbove: null,
    criticalAbove: null,
  },

  app_request_rate: {
    key: 'app_request_rate',
    label: 'Request rate',
    unit: 'rps',
    expr: `sum by (job) (rate(http_requests_total{job=~"$target"}[5m]))`,
    targetLabel: 'job',
    warnAbove: null,
    criticalAbove: null,
  },
  app_error_rate: {
    key: 'app_error_rate',
    label: 'Error rate (5xx)',
    unit: 'percent',
    expr: `100 * (sum by (job) (rate(http_requests_total{status=~"5..",job=~"$target"}[5m])) / clamp_min(sum by (job) (rate(http_requests_total{job=~"$target"}[5m])), 0.001))`,
    targetLabel: 'job',
    warnAbove: 1,
    criticalAbove: 5,
  },
  app_latency_p95: {
    key: 'app_latency_p95',
    label: 'Request latency p95',
    unit: 'seconds',
    expr: `histogram_quantile(0.95, sum by (le, job) (rate(http_request_duration_seconds_bucket{job=~"$target"}[5m])))`,
    targetLabel: 'job',
    warnAbove: 0.5,
    criticalAbove: 1.5,
  },
  app_status_codes: {
    key: 'app_status_codes',
    label: 'Responses by status class',
    unit: 'rps',
    expr: `sum by (status) (rate(http_requests_total{job=~"$target"}[5m]))`,
    targetLabel: 'job',
    warnAbove: null,
    criticalAbove: null,
  },

  container_cpu: {
    key: 'container_cpu',
    label: 'Container CPU',
    unit: 'percent',
    expr: `100 * sum by (name) (rate(container_cpu_usage_seconds_total{name=~"$target"}[5m]))`,
    targetLabel: 'name',
    warnAbove: 80,
    criticalAbove: 95,
  },
  container_memory: {
    key: 'container_memory',
    label: 'Container memory',
    unit: 'bytes',
    expr: `sum by (name) (container_memory_working_set_bytes{name=~"$target"})`,
    targetLabel: 'name',
    warnAbove: null,
    criticalAbove: null,
  },
  container_restarts: {
    key: 'container_restarts',
    label: 'Container restarts (1h)',
    unit: 'count',
    expr: `sum by (name) (increase(container_start_time_seconds{name=~"$target"}[1h] offset 0s) > bool 0)`,
    targetLabel: 'name',
    warnAbove: 1,
    criticalAbove: 3,
  },

  pg_connections: {
    key: 'pg_connections',
    label: 'PostgreSQL connections',
    unit: 'count',
    expr: `sum by (instance) (pg_stat_activity_count{instance=~"$target"})`,
    targetLabel: 'instance',
    warnAbove: null,
    criticalAbove: null,
  },
  pg_database_size: {
    key: 'pg_database_size',
    label: 'Database size',
    unit: 'bytes',
    expr: `pg_database_size_bytes{instance=~"$target"}`,
    targetLabel: 'instance',
    warnAbove: null,
    criticalAbove: null,
  },
  pg_cache_hit_ratio: {
    key: 'pg_cache_hit_ratio',
    label: 'Cache hit ratio',
    unit: 'percent',
    expr: `100 * sum by (instance) (rate(pg_stat_database_blks_hit{instance=~"$target"}[5m])) / clamp_min(sum by (instance) (rate(pg_stat_database_blks_hit{instance=~"$target"}[5m]) + rate(pg_stat_database_blks_read{instance=~"$target"}[5m])), 0.001)`,
    targetLabel: 'instance',
    warnAbove: null,
    criticalAbove: null,
  },
  pg_locks: {
    key: 'pg_locks',
    label: 'Locks held',
    unit: 'count',
    expr: `sum by (instance) (pg_locks_count{instance=~"$target"})`,
    targetLabel: 'instance',
    warnAbove: 200,
    criticalAbove: 500,
  },
  pg_transactions: {
    key: 'pg_transactions',
    label: 'Transactions / second',
    unit: 'rps',
    expr: `sum by (instance) (rate(pg_stat_database_xact_commit{instance=~"$target"}[5m]) + rate(pg_stat_database_xact_rollback{instance=~"$target"}[5m]))`,
    targetLabel: 'instance',
    warnAbove: null,
    criticalAbove: null,
  },
  pg_replication_lag: {
    key: 'pg_replication_lag',
    label: 'Replication lag',
    unit: 'seconds',
    expr: `max by (instance) (pg_replication_lag{instance=~"$target"})`,
    targetLabel: 'instance',
    warnAbove: 30,
    criticalAbove: 300,
  },

  redis_memory: {
    key: 'redis_memory',
    label: 'Redis memory used',
    unit: 'bytes',
    expr: `redis_memory_used_bytes{instance=~"$target"}`,
    targetLabel: 'instance',
    warnAbove: null,
    criticalAbove: null,
  },
  redis_commands: {
    key: 'redis_commands',
    label: 'Redis commands / second',
    unit: 'rps',
    expr: `sum by (instance) (rate(redis_commands_processed_total{instance=~"$target"}[5m]))`,
    targetLabel: 'instance',
    warnAbove: null,
    criticalAbove: null,
  },
  redis_hit_rate: {
    key: 'redis_hit_rate',
    label: 'Redis hit rate',
    unit: 'percent',
    expr: `100 * sum by (instance) (rate(redis_keyspace_hits_total{instance=~"$target"}[5m])) / clamp_min(sum by (instance) (rate(redis_keyspace_hits_total{instance=~"$target"}[5m]) + rate(redis_keyspace_misses_total{instance=~"$target"}[5m])), 0.001)`,
    targetLabel: 'instance',
    warnAbove: null,
    criticalAbove: null,
  },
  redis_evictions: {
    key: 'redis_evictions',
    label: 'Redis evictions / second',
    unit: 'rps',
    expr: `sum by (instance) (rate(redis_evicted_keys_total{instance=~"$target"}[5m]))`,
    targetLabel: 'instance',
    warnAbove: 1,
    criticalAbove: 10,
  },
  redis_connections: {
    key: 'redis_connections',
    label: 'Redis connected clients',
    unit: 'count',
    expr: `redis_connected_clients{instance=~"$target"}`,
    targetLabel: 'instance',
    warnAbove: null,
    criticalAbove: null,
  },
};

/**
 * Escapes a target value for use inside a PromQL label matcher.
 *
 * Even though the value has already passed a conservative character allowlist in
 * validation, regex metacharacters are escaped here too: a matcher is a regex,
 * and `.*` in a target would silently widen the query beyond what the operator
 * selected.
 */
export function escapeTarget(target: string | undefined): string {
  if (!target || target.trim() === '' || target === '*') return '.+';
  return target.replace(/[\\^$.|?*+()[\]{}]/g, (match) => `\\${match}`);
}

export function buildExpression(preset: MetricPreset, target: string | undefined): string {
  return preset.expr.replaceAll('$target', escapeTarget(target));
}
