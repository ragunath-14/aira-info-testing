# Proxmox

## API token, not root

Create a dedicated user and a scoped token. Never use `root@pam` password auth —
tokens can be restricted per path and do not carry a session that expires
mid-request.

```bash
# On a Proxmox node
pveum user add console@pve --comment "AIRAOS Infra Console"

# A role with exactly what the console needs
pveum role add InfraConsole --privs \
  "VM.Audit,VM.Monitor,VM.PowerMgmt,VM.Snapshot,\
Datastore.Audit,Sys.Audit,Sys.Modify,Pool.Audit"

pveum acl modify / --users console@pve --roles InfraConsole
pveum user token add console@pve infra --privsep 0
```

The token secret is shown once. Put it in `PROXMOX_TOKEN_SECRET` and store a copy in
your secret manager.

```env
PROXMOX_API_URL=https://proxmox.internal:8006/api2/json
PROXMOX_TOKEN_ID=console@pve!infra
PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Why each privilege

| Privilege | Needed for |
| --- | --- |
| `VM.Audit` | Guest inventory, config, snapshot list |
| `VM.Monitor` | CPU, memory, disk and network figures |
| `VM.PowerMgmt` | Start, shutdown, reboot, stop |
| `VM.Snapshot` | Creating snapshots |
| `Datastore.Audit` | Storage utilisation |
| `Sys.Audit` | Cluster and node status, the vzdump task log |
| `Sys.Modify` | Reading the task status of an operation the console started |
| `Pool.Audit` | Pool membership, if you use pools |

Deliberately **not** granted: `VM.Allocate`, `VM.Clone`, `VM.Config.*`,
`VM.Console`, `Datastore.Allocate`, `Sys.Console`, `Permissions.Modify`. The console
has no operation that needs them, so granting them would only widen what a stolen
token could do.

To restrict further, apply the ACL to a path rather than `/`:

```bash
pveum acl modify /vms/101 --users console@pve --roles InfraConsole
```

## TLS

Proxmox ships a self-signed certificate. Do one of:

**Preferred — trust the cluster CA:**

```bash
scp root@proxmox:/etc/pve/pve-root-ca.pem /etc/ssl/certs/proxmox-ca.pem
```

```env
PROXMOX_TLS_REJECT_UNAUTHORIZED=true
PROXMOX_CA_CERT_PATH=/etc/ssl/certs/proxmox-ca.pem
```

**Or install a real certificate** on the Proxmox web interface (ACME is built in).

Setting `PROXMOX_TLS_REJECT_UNAUTHORIZED=false` in production **requires**
`PROXMOX_CA_CERT_PATH`; `loadConfig` rejects the combination otherwise. An
unverified TLS session to the thing that controls your VMs is not a configuration
choice worth allowing quietly. When verification is off, the API logs a warning at
startup.

## What the console reads

| Endpoint | Used for |
| --- | --- |
| `/cluster/status` | Cluster name, quorum, node count |
| `/cluster/resources?type=vm` | Whole-cluster guest inventory in one request |
| `/cluster/resources?type=storage` | Storage utilisation |
| `/nodes` | Node list and status |
| `/nodes/{node}/status` | CPU count, memory, rootfs, load, PVE version |
| `/nodes/{node}/tasks?typefilter=vzdump` | Backup verification |
| `/nodes/{node}/{type}/{vmid}/snapshot` | Snapshot list |
| `/nodes/{node}/{type}/{vmid}/agent/network-get-interfaces` | VM addresses |
| `/nodes/{node}/{type}/{vmid}/config` | LXC static addresses |

A standalone node has no `/cluster/status`; the console treats the 501 as a normal
shape and reports "Standalone node" rather than an error.

## Environment resolution

Proxmox tags are semicolon-separated:

```bash
qm set 101 --tags "env:staging;api"
pct set 201 --tags "env:development"
```

If no tag resolves, the **guest name** is checked for a conventional prefix —
`staging-api-01`, `dev-vm-02`, `qa-runner`. If that also fails, the guest is treated
as **production**, so an unlabelled guest inherits the strictest guardrails.

Resolution is in `providers/proxmox/mapper.ts` → `environmentFromGuest()`, with
tests.

## Permitted operations

| Operation | Permission | dev | test | staging | production |
| --- | --- | --- | --- | --- | --- |
| Start | `proxmox.manage` | ✓ | ✓ | ✓ | — |
| Shutdown (graceful) | `proxmox.manage` | ✓ | ✓ | ✓ | — |
| Reboot | `proxmox.manage` | ✓ | ✓ | ✓ | — |
| Stop (hard) | `proxmox.manage` + `infra.manage` | ✓ | ✓ | — | — |
| Snapshot | `proxmox.manage` | ✓ | ✓ | ✓ | — |

Proxmox hosts development, testing and staging in the AIRAOS topology, so no guest
lifecycle operation is offered in production. Hard stop is limited to development
and testing because it risks unflushed writes.

Every operation re-resolves the guest from inventory first, and the **node comes
from inventory, never from the request** — a client cannot redirect an action at a
different node.

Operations return a UPID, which the console records so the action can be correlated
with the cluster task log. Poll `/api/v1/proxmox/tasks/{node}/{upid}` to follow it.

## Backup reporting

The console reads the node's `vzdump` task log and reports a guest's backup as
**verified only when a task completed with `OK`**. A failed or running task shows the
provider's status; no task at all shows "unverified".

It never infers a backup from a schedule or a storage entry. If the console says
unverified, treat it as unverified.

Confirm your backup jobs are configured in **Datacenter → Backup** — the console
reports on them, it does not create them.

## Guest addresses

Addresses are resolved per guest, which costs one API call each, so they appear on
the guest detail page rather than in the cluster inventory. The Network page says so
rather than showing a misleadingly short list.

- **QEMU VMs** need the guest agent:

  ```bash
  apt install qemu-guest-agent && systemctl enable --now qemu-guest-agent
  qm set 101 --agent enabled=1
  ```

- **LXC containers** report static addresses from their config. DHCP containers
  report none, which is shown as "not reported" rather than as an empty address.

## Monitoring

Add `pve-exporter` for Prometheus metrics. Give it its own token with `Sys.Audit`
and `VM.Audit` only — it does not need power management.

```yaml
# pve.yml for prometheus-pve-exporter
default:
  user: exporter@pve
  token_name: prometheus
  token_value: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  verify_ssl: true
```

The scrape config and the Proxmox alert rules are in
[`monitoring/prometheus/`](../monitoring/prometheus/).

## Troubleshooting

**"Proxmox rejected the console's credentials"** — check `PROXMOX_TOKEN_ID` is the
full `user@realm!tokenname`, not just the token name.

**TLS errors** — either trust the CA via `PROXMOX_CA_CERT_PATH` or install a real
certificate. Turning verification off in production requires the CA path anyway.

**Guests missing** — check the tag, then check whether your role covers the
environment it resolved to. An untagged guest resolves to production.

**Node status unavailable but the node is online** — the token needs `Sys.Audit`.
The console degrades gracefully here, showing inventory without node detail.

**Snapshot fails with a permission error** — the token needs `VM.Snapshot`, and the
guest's storage must support snapshots (LVM-thin, ZFS, qcow2 — not raw on LVM).
