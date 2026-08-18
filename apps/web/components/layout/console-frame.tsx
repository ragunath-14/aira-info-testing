'use client';

import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { useSession } from '@/components/layout/session-provider';
import { Spinner } from '@/components/ui/primitives';

/**
 * Chrome around every page.
 *
 * The login route renders bare — no sidebar, no session-dependent chrome — and
 * an unauthenticated operator anywhere else is redirected there rather than shown
 * a shell full of empty panels.
 */
export function ConsoleFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { loading, unauthenticated, user } = useSession();
  const isLoginRoute = pathname === '/login';

  useEffect(() => {
    if (!isLoginRoute && unauthenticated) {
      // Full navigation rather than router.push: it clears client caches that
      // may hold data from the expired session.
      window.location.href = `/login?next=${encodeURIComponent(pathname)}`;
    }
  }, [isLoginRoute, unauthenticated, pathname]);

  if (isLoginRoute) {
    return <main id="main-content">{children}</main>;
  }

  if (loading && !user) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Spinner className="h-6 w-6" />
          <p className="text-sm text-muted-foreground">Loading console…</p>
        </div>
      </div>
    );
  }

  if (unauthenticated) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <p className="text-sm text-muted-foreground">Redirecting to sign in…</p>
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main id="main-content" className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
