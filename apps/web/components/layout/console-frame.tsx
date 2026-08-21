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
  const { loading, user } = useSession();
  const isLoginRoute = pathname === '/login';
  // Any settled session check with no user sends the operator to sign in —
  // not just a clean 401. A cold-started API can bounce the first session
  // check with a network/503 error rather than a real 401, and that should
  // still land on /login instead of stranding the operator on a locked page.
  const needsSignIn = !isLoginRoute && !loading && !user;

  useEffect(() => {
    if (needsSignIn) {
      // Full navigation rather than router.push: it clears client caches that
      // may hold data from the expired session.
      window.location.href = `/login?next=${encodeURIComponent(pathname)}`;
    }
  }, [needsSignIn, pathname]);

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

  if (needsSignIn) {
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
