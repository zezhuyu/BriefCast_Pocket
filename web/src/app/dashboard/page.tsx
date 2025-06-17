"use client";
import { JSX, useEffect, useState } from "react";
import AccountPage from "./account";
import ServerConfigPage from "./server";
import Link from "next/link";
import { getName } from "@tauri-apps/api/app";

interface DashboardTab {
  id: string;
  name: string;
  icon: JSX.Element;
  description: string;
}

const dashboardTabs: DashboardTab[] = [
  {
    id: "account",
    name: "Account",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    ),
    description: "User profile and preferences"
  },
  {
    id: "server",
    name: "Server Config",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
      </svg>
    ),
    description: "RSS feeds and environment variables"
  }
];


export default function DashboardPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('account');
  const [username, setUsername] = useState<string>("");
  const [isTauri, setIsTauri] = useState<boolean>(false);

  useEffect(() => {
    const TauriAvailable = async () => {
      try {
        await getName();
        return true;
      } catch {
        return false; 
      }
    }

    TauriAvailable().then((tauri) => {
      if (tauri) {
        setIsTauri(true)
      }
    })
  }, []);

  const renderContent = () => {
    switch (activeTab) {
      case 'account':
        return <AccountPage username={username} setUsername={setUsername} isTauri={isTauri} />;
      case 'server':
        return <ServerConfigPage isTauri={isTauri} />;
      default:
        return <AccountPage username={username} setUsername={setUsername} isTauri={isTauri} />;
    }
  };

  const handleSignOut = async (e: React.FormEvent) => {
    e.preventDefault();

    const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "signout", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${localStorage.getItem('authToken')}`
      }
    });
    localStorage.removeItem('authToken');
    window.location.href = '/signin';
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900/90 to-purple-900/90">
      <div className="flex">
        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <div className="absolute inset-0 bg-black/50"></div>
          </div>
        )}

        {/* Sidebar */}
        <div className={`min-h-screen fixed inset-y-0 left-0 w-64 bg-white/10 backdrop-blur-md transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}>
          <div className={"flex items-center justify-between h-16 px-6 border-b border-white/10 " + (isTauri ? "mt-8" : "")}>
            <Link href="/" className="text-xl font-bold text-white">BriefCast</Link>
            <button
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden text-white/70 hover:text-white"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <nav className="mt-6 px-3 w-full">
            <div className="space-y-1">
              {dashboardTabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                      isActive
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : 'text-white/70 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {tab.icon}
                    <span className="ml-3">{tab.name}</span>
                  </button>
                );
              })}
            </div>

            {/* User section */}
            <div className="mt-8 pt-6 border-t border-white/10 fixed left-0 bottom-0 w-full">
              <div className="flex items-center px-3 py-2">
                <div className="w-8 h-8 bg-gradient-to-r from-amber-400 to-amber-600 rounded-full flex items-center justify-center">
                  <span className="text-white text-sm font-medium">{username.charAt(0).toUpperCase()}</span>
                </div>
                <div className="ml-3">
                  <p className="text-sm font-medium text-white">{username}</p>
                </div>
              </div>
              <button className="w-full my-2 flex items-center px-3 py-2 mb-4 text-sm text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition-colors" onClick={handleSignOut}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                <span className="ml-3">Sign out</span>
              </button>
            </div>
          </nav>
        </div>

        {/* Main content */}
        <div className="flex-1 lg:ml-0">
          {/* Top bar */}
          <div className={"backdrop-blur-md border-" + (isTauri ? "" : "border-white/10 bg-white/5")}>
            <div className="flex items-center justify-between h-16 px-6">
               {!isTauri && (
                <>
                <button
                    onClick={() => setSidebarOpen(true)}
                    className="lg:hidden text-white/70 hover:text-white"
                >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                </button>

                <div className="flex items-center space-x-4">
                    <h2 className="text-xl font-semibold text-white">
                    {dashboardTabs.find(tab => tab.id === activeTab)?.name || 'Dashboard'}
                    </h2>
                </div>
                </>
               )}
            </div>
          </div>

          {/* Page content */}
          <div className="p-6">
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
} 