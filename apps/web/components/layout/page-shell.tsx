'use client';

import type { ReactNode } from 'react';
import type { Environment } from '@airaos/types';
import { AlertCircle, Lock } from 'lucide-react';
import { useSession } from '@/components/layout/session-provider';
import { EnvironmentBanner } from '@/components/shared/environment-badge';
import { Button, EmptyState, Spinner } from '@/components/ui/primitives';
import { ApiClientError } from '@/lib/api-client';
import { formatRelative } from '@/lib/utils';

/**
 * Standard page frame: heading, optional actions, and the environment banner.
 *
 * Every page that is scoped to a single environment passes it here, so the
 * environment is stated in the same place on every screen (spec section 45).
 */
export function PageShell({
  title,
  description,
  actions,
  environment,
  environmentNote,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  environment?: Environment;
  environmentNote?: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[110rem] px-6 py-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>

      {environment ? (
        <EnvironmentBanner environment={environment} message={environmentNote} className="mb-4" />
      ) : null}

      {children}
    </div>
  );
}

/** Blocks a page when the operator lacks the permission it needs. */
export function PermissionGate({
  permission,
  children,
}: {
  permission: Parameters<ReturnType<typeof useSession>['can']>[0];
  children: ReactNode;
}) {
  const { can, loading, user } = useSession();

  if (loading && !user) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (!can(permission)) {
    return (
      <EmptyState
        icon={<Lock className="h-6 w-6" aria-hidden />}
        title="You do not have access to this page"
        description={`This page requires the ${permission} permission. Ask an owner or infrastructure admin if you need it.`}
      />
    );
  }

  return <>{children}</>;
}

/**
 * Uniform query error panel (spec section 36).
 *
 * Shows the API's own message, the last successful sync when the API reported
 * one, and a retry. Never a stack trace.
 */
export function QueryError({
  error,
  onRetry,
  context,
}: {
  error: unknown;
  onRetry?: () => void;
  context?: string;
}) {
  const apiError = error instanceof ApiClientError ? error : null;
  const message =
    apiError?.message ??
    (error instanceof Error ? error.message : 'Something went wrong loading this data.');

  return (
    <div
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive">
            {context ? `${context} is unavailable` : 'Unavailable'}
          </p>
          <p className="mt-0.5 text-sm">{message}</p>

          {apiError?.lastSuccessAt ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Last successful sync: {formatRelative(apiError.lastSuccessAt)}
            </p>
          ) : null}

          {apiError?.details?.length ? (
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {apiError.details.map((detail) => (
                <li key={`${detail.path}:${detail.message}`}>
                  <span className="mono">{detail.path}</span>: {detail.message}
                </li>
              ))}
            </ul>
          ) : null}

          {apiError?.requestId ? (
            <p className="mt-2 text-2xs text-muted-foreground">
              Request id <span className="mono">{apiError.requestId}</span>
            </p>
          ) : null}

          {onRetry ? (
            <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Marks data served from cache during an upstream outage. */
export function StaleNotice({ cachedAgeMs }: { cachedAgeMs?: number }) {
  if (cachedAgeMs === undefined) return null;
  return (
    <p className="text-2xs text-muted-foreground">
      Showing last known good data from {Math.round(cachedAgeMs / 1000)}s ago — the provider did not
      respond to the latest refresh.
    </p>
  );
}
