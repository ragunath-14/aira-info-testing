'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Gauge, KeyRound, ShieldCheck } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { Button, Card, Input, Label, Spinner } from '@/components/ui/primitives';

/**
 * Sign-in page.
 *
 * SSO is the real path. The local form only appears when the API reports that
 * development login is enabled — in production the endpoint is not registered at
 * all, so there is nothing to show or probe.
 */

interface AuthMethods {
  sso: boolean;
  local: boolean;
  mfaRequired: boolean;
  environment: string;
}

/**
 * useSearchParams opts a route into client rendering, so the boundary has to sit
 * above the component that reads it or the build cannot prerender this page.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-sunken px-4">
      <Spinner className="h-5 w-5" />
    </div>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/';

  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<AuthMethods>('auth/methods')
      .then(setMethods)
      .catch((caught) =>
        setError(
          caught instanceof ApiClientError
            ? caught.message
            : 'The console API is not reachable right now.',
        ),
      );
  }, []);

  const startSso = async () => {
    setBusy(true);
    setError(null);
    try {
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>('auth/login');
      window.location.href = authorizationUrl;
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Could not start sign-in.');
      setBusy(false);
    }
  };

  const submitLocal = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('auth/local', { email, password });
      // Full navigation so the session cookie is picked up everywhere.
      window.location.href = next.startsWith('/') ? next : '/';
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Sign-in failed.');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-sunken px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-lg bg-primary/10">
            <Gauge className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <h1 className="text-lg font-semibold">AIRAOS Infra Console</h1>
          <p className="text-sm text-muted-foreground">
            Internal infrastructure control plane. Access is role-based and audited.
          </p>
        </div>

        <Card className="p-5">
          {error ? (
            <p
              className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {methods?.sso ? (
            <Button
              variant="primary"
              className="w-full"
              loading={busy}
              onClick={() => void startSso()}
            >
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Continue with AIRAOS
            </Button>
          ) : null}

          {methods?.sso && methods?.local ? (
            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-2xs uppercase tracking-wider text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          ) : null}

          {methods?.local ? (
            <form onSubmit={submitLocal} className="space-y-3">
              <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-2xs text-warning">
                Local development login. Not available in production.
              </div>

              <div className="space-y-1">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              <Button type="submit" variant="primary" className="w-full" loading={busy}>
                <KeyRound className="h-4 w-4" aria-hidden />
                Sign in
              </Button>
            </form>
          ) : null}

          {methods && !methods.sso && !methods.local ? (
            <p className="text-sm text-muted-foreground">
              No sign-in method is configured on this console instance. An administrator needs to set
              AIRAOS_AUTH_URL.
            </p>
          ) : null}

          {methods?.mfaRequired ? (
            <p className="mt-4 text-2xs text-muted-foreground">
              Multi-factor authentication is required on your AIRAOS account to use this console.
            </p>
          ) : null}
        </Card>

        <p className="mt-4 text-center text-2xs text-muted-foreground">
          Environment: {methods?.environment ?? '—'}
        </p>
      </div>
    </div>
  );
}
