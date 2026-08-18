'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { Button, Card, Spinner } from '@/components/ui/primitives';

/**
 * SSO redirect target.
 *
 * The identity provider sends the operator back here with `code` and `state` in
 * the query string. Those are POSTed to the API, which does the token exchange
 * server-side — the browser never holds an access token, and the code never
 * appears in a request the browser can replay.
 */
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackFallback />}>
      <CallbackHandler />
    </Suspense>
  );
}

function CallbackFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-sunken px-4">
      <Spinner className="h-5 w-5" />
    </div>
  );
}

/** Reads the code and state the identity provider appended to the redirect. */
function CallbackHandler() {
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(() => {
    // Authorization codes are single-use, so guard against React's development
    // double-effect firing the exchange twice.
    if (exchanged.current) return;
    exchanged.current = true;

    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const providerError = searchParams.get('error');

    if (providerError) {
      setError(
        searchParams.get('error_description') ??
          'AIRAOS declined the sign-in request. Try again from the login page.',
      );
      return;
    }
    if (!code || !state) {
      setError('The sign-in response was incomplete. Start again from the login page.');
      return;
    }

    api
      .post('auth/callback', { code, state })
      .then(() => {
        // Full navigation so every client cache starts from the new session.
        window.location.href = '/';
      })
      .catch((caught) =>
        setError(
          caught instanceof ApiClientError ? caught.message : 'Sign-in could not be completed.',
        ),
      );
  }, [searchParams]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-sunken px-4">
      <Card className="w-full max-w-sm p-6 text-center">
        {error ? (
          <div className="space-y-3">
            <AlertCircle className="mx-auto h-6 w-6 text-destructive" aria-hidden />
            <p className="text-sm font-medium">Sign-in failed</p>
            <p className="text-xs text-muted-foreground">{error}</p>
            <Button variant="primary" onClick={() => (window.location.href = '/login')}>
              Back to sign in
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <ShieldCheck className="mx-auto h-6 w-6 text-primary" aria-hidden />
            <p className="text-sm font-medium">Completing sign-in</p>
            <Spinner className="mx-auto h-5 w-5" />
          </div>
        )}
      </Card>
    </div>
  );
}
