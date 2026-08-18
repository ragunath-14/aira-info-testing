'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, Role, RoleDefinition } from '@airaos/types';
import { ROLES } from '@airaos/types';
import { LogOut, ShieldAlert, UserCheck, UserX } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { useSession } from '@/components/layout/session-provider';
import { formatRelative } from '@/lib/utils';

/**
 * Users page (spec section 29).
 *
 * Identity lives in AIRAOS; what is managed here is the console role. Changing a
 * role revokes the affected operator's sessions immediately, so a downgrade takes
 * effect now rather than at their next sign-in.
 */

interface ConsoleUser {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  roles: Role[];
  permissionCount: number;
  environments: string[];
  mfaVerifiedAt: string | null;
  lastLoginAt: string | null;
  activeSessions: number;
}

export default function UsersPage() {
  return (
    <PermissionGate permission="users.view">
      <Users />
    </PermissionGate>
  );
}

function Users() {
  const { can, user: currentUser } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ConsoleUser | null>(null);
  const [draftRoles, setDraftRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<Paginated<ConsoleUser>>('users', { pageSize: 200 }),
  });

  const roles = useQuery({
    queryKey: ['users', 'roles'],
    queryFn: () => api.get<{ items: RoleDefinition[] }>('users/roles'),
    staleTime: 300_000,
  });

  const saveRoles = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`users/${editing.id}/roles`, { roles: draftRoles });
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The roles could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (target: ConsoleUser, isActive: boolean) => {
    try {
      await api.post(`users/${target.id}/active`, { isActive });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The change could not be applied.');
    }
  };

  const revokeSessions = async (target: ConsoleUser) => {
    await api.post(`users/${target.id}/revoke-sessions`);
    await queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const columns: Array<Column<ConsoleUser>> = [
    {
      key: 'email',
      header: 'Operator',
      sortable: true,
      value: (row) => row.email,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">
            {row.name}
            {row.id === currentUser?.id ? (
              <span className="ml-1.5 text-2xs text-muted-foreground">(you)</span>
            ) : null}
          </p>
          <p className="truncate text-2xs text-muted-foreground">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'roles',
      header: 'Roles',
      value: (row) => row.roles.join(','),
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.roles.length === 0 ? (
            <Badge tone="warning">no role — cannot sign in</Badge>
          ) : (
            row.roles.map((role) => (
              <Badge key={role} tone={role === 'owner' ? 'danger' : 'outline'}>
                {role.replace(/_/g, ' ')}
              </Badge>
            ))
          )}
        </div>
      ),
    },
    {
      key: 'environments',
      header: 'Environments',
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.environments.map((environment) => (
            <EnvironmentBadge
              key={environment}
              environment={environment as 'development' | 'testing' | 'staging' | 'production'}
              size="sm"
            />
          ))}
        </div>
      ),
    },
    {
      key: 'permissions',
      header: 'Permissions',
      sortable: true,
      value: (row) => row.permissionCount,
      render: (row) => <span className="text-xs">{row.permissionCount}</span>,
    },
    {
      key: 'mfa',
      header: 'MFA',
      sortable: true,
      value: (row) => (row.mfaVerifiedAt ? 1 : 0),
      render: (row) =>
        row.mfaVerifiedAt ? (
          <Badge tone="success">verified</Badge>
        ) : (
          <Badge tone="warning">not seen</Badge>
        ),
    },
    {
      key: 'sessions',
      header: 'Sessions',
      sortable: true,
      value: (row) => row.activeSessions,
      render: (row) => <span className="text-xs">{row.activeSessions}</span>,
    },
    {
      key: 'lastLogin',
      header: 'Last sign-in',
      sortable: true,
      value: (row) => row.lastLoginAt,
      render: (row) => (
        <span className="text-xs text-muted-foreground">{formatRelative(row.lastLoginAt)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      value: (row) => (row.isActive ? 1 : 0),
      render: (row) =>
        row.isActive ? <Badge tone="success">active</Badge> : <Badge tone="neutral">deactivated</Badge>,
    },
    {
      key: 'actions',
      header: '',
      render: (row) =>
        can('users.manage') ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setEditing(row);
                setDraftRoles(row.roles);
                setError(null);
              }}
            >
              Roles
            </Button>
            {row.activeSessions > 0 ? (
              <Button
                size="icon"
                variant="ghost"
                title="Revoke all sessions"
                aria-label={`Revoke sessions for ${row.email}`}
                onClick={() => void revokeSessions(row)}
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : null}
            <Button
              size="icon"
              variant="ghost"
              title={row.isActive ? 'Deactivate account' : 'Reactivate account'}
              aria-label={row.isActive ? `Deactivate ${row.email}` : `Reactivate ${row.email}`}
              disabled={row.id === currentUser?.id && row.isActive}
              onClick={() => void setActive(row, !row.isActive)}
            >
              {row.isActive ? (
                <UserX className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <UserCheck className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <PageShell
      title="Users"
      description="Console role assignment. Identity and credentials are managed in AIRAOS, not here."
    >
      {error ? (
        <p
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {users.error ? (
        <QueryError error={users.error} onRetry={() => void users.refetch()} context="Users" />
      ) : (
        <DataTable
          rows={users.data?.items ?? []}
          columns={columns}
          rowKey={(row) => row.id}
          loading={users.isLoading}
          searchPlaceholder="Search by name or email…"
          emptyTitle="No console users yet"
          emptyDescription="A user record is created the first time someone signs in through AIRAOS."
        />
      )}

      {editing ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 p-4 pt-[12vh] backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setEditing(null);
          }}
        >
          <Card className="w-full max-w-lg">
            <CardHeader
              title={`Roles for ${editing.email}`}
              description="Saving revokes this operator's sessions so the change takes effect immediately."
            />
            <CardBody className="space-y-3">
              <ul className="space-y-2">
                {ROLES.map((role) => {
                  const definition = roles.data?.items.find((item) => item.key === role);
                  const checked = draftRoles.includes(role);
                  return (
                    <li key={role} className="rounded-md border border-border p-2.5">
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            setDraftRoles((current) =>
                              event.target.checked
                                ? [...current, role]
                                : current.filter((value) => value !== role),
                            )
                          }
                          className="mt-0.5 h-3.5 w-3.5"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{definition?.label ?? role}</p>
                            {role === 'owner' ? <Badge tone="danger">full access</Badge> : null}
                          </div>
                          <p className="text-2xs text-muted-foreground">
                            {definition?.description ?? ''}
                          </p>
                          {definition ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {definition.environments.map((environment) => (
                                <EnvironmentBadge key={environment} environment={environment} size="sm" />
                              ))}
                              <Badge tone="outline">{definition.permissions.length} permissions</Badge>
                            </div>
                          ) : null}
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>

              {draftRoles.includes('owner') && !editing.roles.includes('owner') ? (
                <p className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  Owner grants unrestricted access to every environment, including production writes.
                </p>
              ) : null}

              {draftRoles.length === 0 ? (
                <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  With no role this operator can authenticate but cannot use the console.
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="primary" loading={busy} onClick={() => void saveRoles()}>
                  Save roles
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}
