import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppProviders } from '@/components/layout/session-provider';
import { ConsoleFrame } from '@/components/layout/console-frame';

export const metadata: Metadata = {
  title: 'AIRAOS Infra Console',
  description: 'Internal infrastructure control plane for AIRAOS.',
  // An internal console has no business in a search index.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <AppProviders>
          <ConsoleFrame>{children}</ConsoleFrame>
        </AppProviders>
      </body>
    </html>
  );
}
