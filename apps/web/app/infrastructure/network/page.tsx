'use client';

import { useQuery } from '@tanstack/react-query';
import type { DoFirewall, DoFloatingIp, Environment } from '@airaos/types';
import { Info, Network } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EnvironmentBadge } from '@/components/shared/environment-badge';

/**
 * Network view. Read-only: the console reports addressing and firewall rules but
 * has no route that changes networking.
 */

interface AddressRow {
  address: string;
  scope: 'public' | 'private';
  resource: string;
  resourceKind: 'droplet' | 'proxmox_guest';
  environment: Environment;
  region: string;
}

interface NetworkResponse {
  addresses: AddressRow[];
  floatingIps: DoFloatingIp[];
  firewalls: DoFirewall[];
  note: string | null;
}

export default function NetworkPage() {
  return (
    <PermissionGate permission="infra.view">
      <NetworkView />
    </PermissionGate>
  );
}

function NetworkView() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['network'],
    queryFn: () => api.get<NetworkResponse>('network'),
    refetchInterval: 120_000,
  });

  const columns: Array<Column<AddressRow>> = [
    {
      key: 'address',
      header: 'Address',
      sortable: true,
      value: (row) => row.address,
      render: (row) => <span className="mono text-xs">{row.address}</span>,
    },
    {
      key: 'scope',
      header: 'Scope',
      sortable: true,
      value: (row) => row.scope,
      render: (row) => (
        <Badge tone={row.scope === 'public' ? 'warning' : 'neutral'}>{row.scope}</Badge>
      ),
    },
    {
      key: 'resource',
      header: 'Resource',
      sortable: true,
      value: (row) => row.resource,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm">{row.resource}</p>
          <p className="text-2xs text-muted-foreground">
            {row.resourceKind === 'droplet' ? 'DigitalOcean droplet' : 'Proxmox guest'}
          </p>
        </div>
      ),
    },
    {
      key: 'environment',
      header: 'Environment',
      sortable: true,
      value: (row) => row.environment,
      render: (row) => <EnvironmentBadge environment={row.environment} size="sm" />,
    },
    {
      key: 'region',
      header: 'Region / node',
      sortable: true,
      value: (row) => row.region,
      render: (row) => <span className="text-xs text-muted-foreground">{row.region}</span>,
    },
  ];

  return (
    <PageShell
      title="Network"
      description="Addressing and firewall configuration across both providers."
    >
      {error ? (
        <QueryError error={error} onRetry={() => void refetch()} context="Network inventory" />
      ) : (
        <div className="space-y-4">
          {data?.note ? (
            <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{data.note}</span>
            </div>
          ) : null}

          <DataTable
            rows={data?.addresses ?? []}
            columns={columns}
            rowKey={(row) => `${row.resourceKind}-${row.resource}-${row.address}`}
            loading={isLoading}
            searchPlaceholder="Search addresses or resources…"
            emptyTitle="No addresses known"
            emptyDescription="Configure DigitalOcean or Proxmox to populate this view."
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Floating IPs"
                description="Reserved addresses and what they currently point at."
              />
              <CardBody className="pt-1">
                {(data?.floatingIps ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No floating IPs reserved.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {data?.floatingIps.map((floating) => (
                      <li key={floating.ip} className="flex items-center justify-between gap-3 text-sm">
                        <span className="mono">{floating.ip}</span>
                        <span className="text-xs text-muted-foreground">
                          {floating.dropletId ? `droplet ${floating.dropletId}` : 'unassigned'} ·{' '}
                          {floating.region}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Firewalls"
                description="Inbound rules, as configured at the provider."
              />
              <CardBody className="space-y-3 pt-1">
                {(data?.firewalls ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No firewalls configured.</p>
                ) : (
                  data?.firewalls.map((firewall) => (
                    <div key={firewall.id}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{firewall.name}</p>
                        <Badge tone={firewall.status === 'succeeded' ? 'success' : 'neutral'}>
                          {firewall.status}
                        </Badge>
                      </div>
                      <p className="text-2xs text-muted-foreground">
                        {firewall.dropletIds.length} droplet(s)
                        {firewall.tags.length > 0 ? ` · tags: ${firewall.tags.join(', ')}` : ''}
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {firewall.inboundRules.map((rule, index) => (
                          <li key={index} className="mono text-2xs text-muted-foreground">
                            {rule.protocol}/{rule.ports} ← {rule.sources.join(', ') || 'any'}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </CardBody>
            </Card>
          </div>

          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Network className="h-3 w-3" aria-hidden />
            This page is read-only. Network changes are made at the provider or through
            infrastructure-as-code, not from the console.
          </p>
        </div>
      )}
    </PageShell>
  );
}
