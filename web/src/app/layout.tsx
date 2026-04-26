"use client"
import { Suspense, useEffect, useState } from 'react';
import { PlayerProvider } from '@/context/PlayerContext';
import './globals.css';
import { Inter } from 'next/font/google';

// Electron passes --localstorage-file to its Node.js runtime. When that flag
// has no valid path (e.g. during Next.js SSR), it installs a broken
// global.localStorage whose .getItem is not a function. Delete it here so
// SSR never sees a half-initialised localStorage object.
if (typeof globalThis !== 'undefined') {
  const _ls = (globalThis as any).localStorage;
  if (_ls !== undefined && typeof _ls?.getItem !== 'function') {
    try { delete (globalThis as any).localStorage; } catch (_) {}
  }
}

const inter = Inter({ subsets: ['latin'] });

function ProviderStatusBanner() {
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then((data: any) => {
        if (data?.providerStatus?.rateLimited) {
          const until = data.providerStatus.until
            ? new Date(data.providerStatus.until).toLocaleTimeString()
            : 'later';
          setWarning(`AI provider (${data.providerStatus.provider}) is rate-limited. Using fallback until ${until}.`);
        }
      })
      .catch(() => {});
  }, []);

  if (!warning) return null;
  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500/90 text-black text-sm text-center py-2 px-4 backdrop-blur-sm">
      ⚠️ {warning}
    </div>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PlayerProvider>
      <html lang="en" className="h-full w-full rounded-2xl">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="mobile-web-app-capable" content="yes" />
          <meta name="theme-color" content="#6422FE" />
          <meta httpEquiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
          <meta httpEquiv="Pragma" content="no-cache" />
          <meta httpEquiv="Expires" content="0" />
        </head>
        <body className="h-full w-full bg-white">
          <ProviderStatusBanner />
          <div className="h-full w-full bg-white shadow-xl flex flex-col rounded-2xl">
            <div className="flex-1 overflow-y-auto">
              <Suspense fallback={<div>Loading...</div>}>
                {children}
              </Suspense>
            </div>
          </div>
        </body>
      </html>
    </PlayerProvider>
  );
}
