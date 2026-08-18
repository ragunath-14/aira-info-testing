# Monitoring

The console gives an operational overview; Grafana remains the tool for deep
analysis. It links out to Grafana rather than embedding it — duplicating Grafana
would be a second dashboard to maintain, and embedding it would mean loosening the
console's CSP.

## Components

| Component | Role |
| --- | --- |
| Prometheus | Metrics collection and alert evaluation |
| Alertmanager | Routing, grouping, inhibition |
| Grafana | Dashboards and ad-hoc exploration |
| node-exporter | Host CPU, memory, disk, network, load |
| cAdvisor | Container CPU, memory, restarts |
| pve-exporter | Proxmox cluster, node and guest metrics |
| postgres-exporter | Connections, size, cache hit ratio, locks, replication |
| redis-exporter | Memory, commands, hit rate, evictions |

Configuration lives in [`monitoring/`](../monitoring/) and is mounted read-only by
the compose file.

## The environment label is load-bearing

Every scrape target must carry an `environment` label. The console's presets and the
alert rules both use it, and RBAC scopes what an operator sees by it.

```yaml
- job_name: node
  static_configs:
    - targets: ['10.20.30.11:9100']
      labels: { environment: production, role: app }
    - targets: ['10.10.20.11:9100']
      labels: { environment: staging, role: app }
```

An alert with **no** environment label is shown to every operator rather than
hidden — an unlabelled critical alert must not be invisible. Fix the label in the
rule rather than relying on that fallback.

For applications, the `job` label should match the application registry key, because
the `app_*` presets filter on it.

## Preset catalogue, not PromQL

The browser names a preset and an optional target; the server builds the expression.
Arbitrary PromQL from a browser can read any series in the TSDB and is trivially
expensive, so it is not accepted.

| Group | Presets |
| --- | --- |
| Infrastructure | `node_cpu`, `node_memory`, `node_disk`, `node_filesystem`, `node_load`, `node_network` |
| Applications | `app_request_rate`, `app_error_rate`, `app_latency_p95`, `app_status_codes` |
| Containers | `container_cpu`, `container_memory`, `container_restarts` |
| PostgreSQL | `pg_connections`, `pg_database_size`, `pg_cache_hit_ratio`, `pg_locks`, `pg_transactions`, `pg_replication_lag` |
| Redis | `redis_memory`, `redis_commands`, `redis_hit_rate`, `redis_evictions`, `redis_connections` |

Target values are escaped for regex metacharacters before substitution — even
though validation already restricts the character set — because a matcher is a
regex, and `.*` in a target would silently widen the query beyond what the operator
selected.

Add a preset in `apps/api/src/providers/prometheus/presets.ts` and register its key
in `packages/validation/src/observability.ts`.

## A metric that cannot be collected is not zero

Every metric response carries either a value or an `unavailableReason`. The UI shows
"Not collected" with the reason, never `0`. A missing exporter and an idle service
must not look the same — this is the same principle as `unknown` health never
rendering as `healthy`.

## Application metrics

Expose `/metrics` from each AIRAOS service with:

- `http_requests_total{status, method, route}` — counter
- `http_request_duration_seconds_bucket{le, route}` — histogram
- `up` — from the scrape itself

The console's error-rate preset uses `clamp_min` on the denominator so a service with
no traffic reports 0% rather than dividing by zero.

## Health endpoints

Each service should expose `/health`, and preferably `/health/live` and
`/health/ready`. The console probes whatever URL the registry names — point it at
`/health/ready` for services that distinguish readiness from liveness, since
readiness is what determines whether traffic should arrive.

Recognised response shapes:

```json
{ "status": "ok" }
{ "state": "degraded", "message": "cache unavailable" }
{ "status": "ok", "checks": [{ "name": "postgres", "status": "ok" }] }
```

`status`/`state` may be `ok`/`up`/`healthy`/`pass`, `degraded`/`warn`, or
`down`/`fail`/`error`. A `checks` array populates the dependency list on the service
detail page. An unparseable body is treated as no extra information rather than as a
failure — the HTTP status still decides.

Probes have a 4-second timeout, redirects are not followed, and each result is
persisted so the UI can show "last successful check" while a service is failing.

## Alert conventions

Rules live in [`monitoring/prometheus/rules/airaos.yml`](../monitoring/prometheus/rules/airaos.yml).
Every rule follows these, because the console relies on them:

- `severity` is `critical`, `warning` or `info`. Anything else is treated as info.
- `environment` is inherited from target labels.
- `summary` is one line an operator can act on; `description` carries detail.
- `runbook_url` is surfaced as a link in the console — add one wherever a runbook
  exists.

Covered: target down, host CPU/memory/disk (including a predictive
"will fill within 24 hours"), load, application error rate and latency, container
restart loops, PostgreSQL availability, connection saturation, replication lag and
cache hit ratio, Redis availability, memory and evictions, Proxmox node and quorum
state, storage utilisation, TLS expiry at 21 and 7 days, and the console's own API.

### Routing

`monitoring/alertmanager/alertmanager.yml` routes by severity first, environment
second:

| Route | Wait | Repeat |
| --- | --- | --- |
| production + critical | 10s | 30m |
| critical | 30s | 2h |
| warning | 45s | 12h |
| info | 45s | 24h |

Inhibition rules stop cascades: a down target suppresses its own resource alerts, a
critical suppresses the matching warning, and an offline Proxmox node suppresses its
guests being unreachable.

The `default` receiver is deliberately empty — an alert reaching it has no severity
label, which should be fixed in the rule rather than routed somewhere.

Webhook URLs are credentials. They come from environment substitution at deploy
time and are never committed.

## Acknowledging is not silencing

The console records ownership; Alertmanager remains the source of truth for what is
firing.

- **Acknowledge** records that you own the alert. It does **not** silence it, and the
  UI says so — an operator who believes "ack" hides the alert from the team will be
  surprised later.
- **Resolve** requires a description of what fixed it, kept with the alert history.

Acknowledgement state lives in `alert_acknowledgements`, keyed by Alertmanager's
fingerprint, and both actions are audited. Use an Alertmanager silence when you
genuinely want an alert suppressed.

## Grafana

Datasources and dashboard providers are provisioned read-only from
[`monitoring/grafana/provisioning/`](../monitoring/grafana/provisioning/), so a
Grafana user cannot repoint the datasource.

The console deep-links to these UIDs: `airaos-infra`, `airaos-apps`,
`airaos-postgres`, `airaos-redis`. Keep them stable, or update
`grafanaLinks()` in `providers/prometheus/service.ts`.

Embedding is disabled (`GF_SECURITY_ALLOW_EMBEDDING=false`) and anonymous access is
off.

## Retention and cost

Prometheus retains 30 days by default. The console adds its own short-retention
buffers, trimmed by `retention.ts`:

| Data | Retention | Setting |
| --- | --- | --- |
| Prometheus TSDB | 30d | `--storage.tsdb.retention.time` |
| Console log buffer | 14d | `logs.retention_days` |
| Application health history | 30d | `health_history.retention_days` |
| Audit events | indefinite | never trimmed |
| Query history | indefinite | never trimmed |

The console is not a log warehouse. Its buffer exists so the Logs page works and so
deployment logs stay attached to their records; Loki or your platform's log stack
remains the long-term store.

## Verifying the setup

```bash
# Targets up
curl -s localhost:9090/api/v1/query?query='up' | jq '.data.result | length'

# Anything down
curl -s localhost:9090/api/v1/query?query='count(up==0)' | jq '.data.result[0].value[1]'

# Rules loaded
curl -s localhost:9090/api/v1/rules | jq '.data.groups | length'

# Alertmanager reachable
curl -s localhost:9093/api/v2/status | jq '.cluster.status'
```

Then check Monitoring → Health in the console, which lists every subsystem *and* the
ones that did not report. That list is how a monitoring gap gets noticed rather than
mistaken for calm.
