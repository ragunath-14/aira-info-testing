'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ENVIRONMENT_PRESENTATION } from '@airaos/types';
import { ChevronDown, LogOut, Moon, RefreshCw, Sun, Unlock } from 'lucide-react';
import { api } from '@/lib/api-client';
import { useSession } from '@/components/layout/session-provider';
import { Badge, Button } from '@/components/ui/primitives';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { formatRelative } from '@/lib/utils';

/**
 * Top bar: who is signed in, which environments they can act in, open database
 * write windows, and a manual refresh.
 *
 * The write-window indicator is deliberately prominent. An operator with an open
 * production write window should never be able to forget it is open.
 */
export function Topbar() {
  const { user, writeWindows, environments } = useSession();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [dark, setDark] = useState(false);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await api.post('auth/logout');
      window.location.href = '/login';
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-4">
      <div className="flex min-w-0 items-center gap-3">
        {/*
          The environment row is the first thing to give up on a narrow window:
          it is a convenience (the same list is in the account menu), whereas the
          write-mode indicator below must never be hidden.
        */}
        <div className="hidden items-center gap-1.5 lg:flex">
          <span className="text-2xs uppercase tracking-wider text-muted-foreground">Access</span>
          {environments.length === 0 ? (
            <Badge tone="neutral">none</Badge>
          ) : (
            environments.map((environment) => (
              <EnvironmentBadge key={environment} environment={environment} size="sm" />
            ))
          )}
        </div>

        {writeWindows.length > 0 ? (
          <div className="flex items-center gap-1.5" role="status">
            <Badge tone="danger">
              <Unlock className="h-3 w-3" aria-hidden />
              {writeWindows.length === 1
                ? `Write mode open (expires ${formatRelative(writeWindows[0]?.expiresAt)})`
                : `${writeWindows.length} write windows open`}
            </Badge>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          title="Refresh all data"
          aria-label="Refresh all data"
          onClick={() => void queryClient.invalidateQueries()}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        >
          {dark ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
        </Button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
              {(user?.name ?? '?').slice(0, 2).toUpperCase()}
            </span>
            <span className="hidden max-w-[12rem] truncate sm:inline">{user?.email ?? 'Not signed in'}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          </button>

          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 z-40 mt-1 w-72 rounded-md border border-border bg-surface-raised p-2 shadow-lg"
            >
              <div className="border-b border-border px-2 pb-2">
                <p className="truncate text-sm font-medium">{user?.name}</p>
                <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(user?.roles ?? []).map((role) => (
                    <Badge key={role} tone="outline">
                      {role.replace(/_/g, ' ')}
                    </Badge>
                  ))}
                </div>
                <dl className="mt-2 space-y-0.5 text-2xs text-muted-foreground">
                  <div className="flex justify-between">
                    <dt>MFA</dt>
                    <dd>{user?.mfaVerified ? 'verified' : 'not verified'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Session expires</dt>
                    <dd>{formatRelative(user?.sessionExpiresAt)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Permissions</dt>
                    <dd>{user?.permissions.length ?? 0}</dd>
                  </div>
                </dl>
              </div>

              <div className="px-2 py-2">
                <p className="mb-1 text-2xs uppercase tracking-wider text-muted-foreground">
                  Environments
                </p>
                <ul className="space-y-0.5 text-xs">
                  {(user?.environments ?? []).map((environment) => (
                    <li key={environment} className="flex items-center justify-between">
                      <span>{ENVIRONMENT_PRESENTATION[environment].label}</span>
                      <EnvironmentBadge environment={environment} size="sm" />
                    </li>
                  ))}
                </ul>
              </div>

              <Button
                variant="ghost"
                className="w-full justify-start"
                loading={signingOut}
                onClick={() => void signOut()}
                role="menuitem"
              >
                <LogOut className="h-4 w-4" aria-hidden />
                Sign out
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
