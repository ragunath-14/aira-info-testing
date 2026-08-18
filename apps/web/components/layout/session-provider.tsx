'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { AuthenticatedUser, Environment, Permission, WriteModeWindow } from '@airaos/types';
import { api, ApiClientError } from '@/lib/api-client';

/**
 * Session context.
 *
 * The permission helpers here decide what the UI *renders*. They are not the
 * security boundary — the API re-checks every permission on every request
 * (rules 9, 10). Hiding a control the operator cannot use is a courtesy, not a
 * control.
 */

interface SessionDescriptor {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface SessionPayload {
  user: AuthenticatedUser;
  sessions: SessionDescriptor[];
  writeWindows: WriteModeWindow[];
}

interface SessionContextValue {
  user: AuthenticatedUser | null;
  sessions: SessionDescriptor[];
  writeWindows: WriteModeWindow[];
  loading: boolean;
  /** True when the API said the operator is not signed in. */
  unauthenticated: boolean;
  error: string | null;
  can: (permission: Permission, environment?: Environment) => boolean;
  canSeeEnvironment: (environment: Environment) => boolean;
  environments: Environment[];
  refresh: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Infrastructure state ages quickly; the API caches upstream so a short
        // client stale time is cheap.
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          // Never retry an auth or permission failure: it will not succeed and
          // each attempt is another audit line.
          if (error instanceof ApiClientError) {
            if (error.isAuthError || error.code === 'FORBIDDEN') return false;
            return error.retryable && failureCount < 2;
          }
          return failureCount < 1;
        },
      },
      mutations: { retry: false },
    },
  });
}

export function AppProviders({ children }: { children: ReactNode }) {
  const queryClient = useMemo(makeQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}

function SessionProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionPayload>('auth/session'),
    // The session drives every permission check, so it is refreshed regularly:
    // a revoked role should take effect within a minute, not at next reload.
    refetchInterval: 60_000,
    retry: false,
  });

  const apiError = error instanceof ApiClientError ? error : null;

  const value = useMemo<SessionContextValue>(() => {
    const user = data?.user ?? null;
    return {
      user,
      sessions: data?.sessions ?? [],
      writeWindows: data?.writeWindows ?? [],
      loading: isLoading,
      unauthenticated: Boolean(apiError?.isAuthError),
      error: apiError && !apiError.isAuthError ? apiError.message : null,
      environments: user?.environments ?? [],
      can: (permission, environment) => {
        if (!user) return false;
        if (!user.permissions.includes(permission)) return false;
        if (environment && !user.environments.includes(environment)) return false;
        return true;
      },
      canSeeEnvironment: (environment) => Boolean(user?.environments.includes(environment)),
      refresh: () => void refetch(),
    };
  }, [data, isLoading, apiError, refetch]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside AppProviders');
  }
  return context;
}
