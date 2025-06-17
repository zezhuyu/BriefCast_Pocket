"use client"
import { useState, useEffect } from 'react';
import { PlayerProvider } from '@/context/PlayerContext';
import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Suspense } from 'react';
import Titlebar from '@/components/Titlebar';
import { getName } from '@tauri-apps/api/app';
const inter = Inter({ subsets: ['latin'] });


export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [showBar, setShowBar] = useState(false)

  useEffect(() => {
    const isTauri = async () => {
      try {
        await getName();
        return true;
      } catch {
        return false;
      }
    }

    isTauri().then((isTauri) => {
      if (isTauri) {
        setShowBar(true)
      }
    })
  }, [])

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
            <Titlebar />
            <div className={`h-full w-full bg-white shadow-xl flex flex-col rounded-2xl ${showBar ? " overflow-hidden" : ""}`}>
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
