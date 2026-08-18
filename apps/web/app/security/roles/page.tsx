'use client';

import { useQuery } from '@tanstack/react-query';
import type { RoleDefinition } from '@airaos/types';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { EnvironmentBadge } from '@/components/shared/environment-badge';

/**
 * Roles page.
 *
 * Read-only, and rendered from the same definitions the backend enforces — so
 * what an operator reads here is exactly what the API will do, not a
 * documentation copy that can drift.
 */
export default function RolesPage() {
  return (
    <PermissionGate permission="users.view">
      <Roles />
    </PermissionGate>
  );
}

function Roles() {
  const roles = useQuery({
    queryKey: ['users', 'roles'],
    queryFn: () => api.get<{ items: RoleDefinition[] }>('users/roles'),
    staleTime: 300_000,
  });

  return (
    <PageShell
      title="Roles"
      description="The permission bundles the backend enforces. Roles are fixed in code so they cannot drift from what is checked."
    >
      {roles.error ? (
        <QueryError error={roles.error} onRetry={() => void roles.refetch()} context="Roles" />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {(roles.data?.items ?? []).map((role) => (
              <Card key={role.key}>
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
                      {role.label}
                      {role.key === 'owner' ? <Badge tone="danger">unrestricted</Badge> : null}
                    </span>
                  }
                  description={role.description}
                  actions={<Badge tone="outline">{role.permissions.length} permissions</Badge>}
                />
                <CardBody className="space-y-3">
                  <div>
                    <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                      May act in
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {role.environments.map((environment) => (
                        <EnvironmentBadge key={environment} environment={environment} size="sm" showFullLabel />
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Permissions
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {role.permissions.map((permission) => (
                        <span
                          key={permission}
                          className="mono rounded border border-border bg-surface-sunken px-1.5 py-0.5 text-2xs"
                        >
                          {permission}
                        </span>
                      ))}
                    </div>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader title="How a permission becomes effective" />
            <CardBody>
              <ol className="space-y-2 text-xs text-muted-foreground">
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-muted text-2xs font-semibold">
                    1
                  </span>
                  The operation itself must be permitted in that environment at all. Some are not — a
                  hard VM stop is unavailable in staging and production regardless of role.
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-muted text-2xs font-semibold">
                    2
                  </span>
                  The role must cover that environment. A developer holding application.restart still
                  cannot restart a production service.
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-muted text-2xs font-semibold">
                    3
                  </span>
                  For production, a second permission is often required — for example
                  application.deploy.production, or database.admin for a production write.
                </li>
                <li className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                  The backend re-derives all three on every request. The UI only decides what to render.
                </li>
              </ol>
            </CardBody>
          </Card>
        </div>
      )}
    </PageShell>
  );
}
