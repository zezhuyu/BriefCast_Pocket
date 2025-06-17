"use client";
import { JSXElementConstructor, Key, ReactElement, ReactNode, ReactPortal, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import MiniPlayer from "@/components/MiniPlayer";
import { usePlayer } from "@/context/PlayerContext";
import { useEffect } from "react";
import { getName } from "@tauri-apps/api/app";
// Sample history data - in a real app, this would come from a database or API

// Group history by month

const parseDateString = (timestamp: string | number): Date => {
  if (typeof timestamp === 'number') {
    return new Date(timestamp * 1000);
  }

  // 1. Replace space with 'T' to match ISO format
  // 2. Remove microseconds (keep only 3 digits or less after .)
  const cleaned = timestamp
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1'); // trim to milliseconds

  return new Date(cleaned);
};

const toDate = (timestamp: string | number): string => {
  let date = parseDateString(timestamp);
  if (isNaN(date.getTime())) return 'invalid date';

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs !== 1 ? 's' : ''} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  if (diffDays < 365) return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`;
  return `${diffYears} year${diffYears !== 1 ? 's' : ''} ago`;
};

interface HistoryItem {
  id: string;
  image_url: string;
  title: string;
  subcategory: string;
  listen_duration_seconds: number;
  duration_seconds: number;
  stop_position_seconds: number;
  listened_at: number;
}

const groupHistoryByMonth = (history: HistoryItem[]): Record<string, HistoryItem[]> => {
  const grouped: Record<string, HistoryItem[]> = {};

  history.forEach(item => {
    let date = new Date(item.listened_at as number * 1000);
    if (isNaN(date.getTime())) {
      date = new Date(item.listened_at);
    }

    const monthYear = date.toLocaleString('default', {
      month: 'long',
      year: 'numeric',
    });

    if (!grouped[monthYear]) {
      grouped[monthYear] = [];
    }

    grouped[monthYear].push(item);
  });

  return grouped;
};

export default function HistoryPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const router = useRouter();
  const [history, setHistory] = useState<any[]>([]);
  const { setCurrentPodcast, togglePlayPause, setAutoPlay } = usePlayer();
  const [tauri, setTauri] = useState(false)

  const fetchHistory = async (): Promise<any[]> => {
    return new Promise(resolve => {
      setTimeout(async () => {
        const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "history", {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${localStorage.getItem('authToken')}`
          },
          // credentials: 'same-origin'
        });  
        const data = await response.json();
        resolve(data);
      }, 500);
    });
  }

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
        setTauri(true)
      }
    })
    fetchHistory().then((data: any[]) => {
      setHistory(data);
    });
  }, []);

  // Filter history based on search term
  const filteredHistory = history.filter((item: {
    title: string;
    subcategory: string;
  }) => 
    item.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.subcategory.toLowerCase().includes(searchTerm.toLowerCase())
  );
  
  // Group filtered history by month
  const groupedHistory = groupHistoryByMonth(filteredHistory);
  
  const handlePodcastClick = (podcastId: Key | null | undefined) => {
    setAutoPlay(false);
    router.push(`/?podcast=${podcastId}`);
  };
  
  // Render a history item
  const renderHistoryItem = (item: {
    stop_position_seconds: number; id: Key | null | undefined; image_url: any; title: string | number | bigint | boolean | ReactElement<unknown, string | JSXElementConstructor<any>> | Iterable<ReactNode> | Promise<string | number | bigint | boolean | ReactPortal | ReactElement<unknown, string | JSXElementConstructor<any>> | Iterable<ReactNode> | null | undefined> | null | undefined; listen_duration_seconds: number; duration_seconds: number; subcategory: string | number | bigint | boolean | ReactElement<unknown, string | JSXElementConstructor<any>> | Iterable<ReactNode> | ReactPortal | Promise<string | number | bigint | boolean | ReactPortal | ReactElement<unknown, string | JSXElementConstructor<any>> | Iterable<ReactNode> | null | undefined> | null | undefined; listened_at: number; 
}) => (
    <div 
      key={item.id}
      className="bg-white/10 backdrop-blur-sm rounded-lg shadow-md overflow-hidden cursor-pointer hover:shadow-lg transition-all hover:bg-white/20"
      onClick={() => handlePodcastClick(item.id)}
    >
      <div className="relative aspect-square">
        <Image
          src={item.image_url?.startsWith('http') ? item.image_url : process.env.NEXT_PUBLIC_BACKEND_URL + `files/${item.image_url}`}
          alt={item.title?.toString() || ''}
          fill
          className="object-cover"
        />
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
          <div 
            className="h-full bg-amber-500"
            style={{ width: `${item.stop_position_seconds / item.duration_seconds * 100}%` }}
          />
        </div>
      </div>
      <div className="p-4">
        <h3 className="font-medium text-white text-sm line-clamp-1">{item.title}</h3>
        <p className="text-white/70 text-xs mb-1">{item.subcategory}</p>
        <div className="flex justify-between items-center mt-2">
          <span className="text-white/50 text-xs">{toDate(item.listened_at)}</span>
          <span className="text-amber-400 text-xs">{(item.stop_position_seconds / item.duration_seconds * 100).toFixed(0)}% completed</span>
        </div>
      </div>
    </div>
  );
  
  return (
    <div className={`min-h-screen bg-gradient-to-br from-indigo-900/90 to-purple-900/90 text-white ${tauri ? 'mt-8' : ''}`}>
      <header className="bg-white/10 backdrop-blur-md shadow-lg">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Link href="/" className="text-2xl font-bold text-white">BriefCast</Link>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-white/80 hover:text-white">Player</Link>
            <Link href="/library" className="text-white/80 hover:text-white">Library</Link>
            <Link href="/downloads" className="text-white/80 hover:text-white">Downloads</Link>
            <Link href="/history" className="text-white font-medium">History</Link>
            <Link 
                href="/dashboard" 
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white/80 hover:text-white transition-all duration-200 border border-white/20 hover:border-white/40"
                title="Dashboard"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </Link>
          </div>
        </div>
      </header>
      
      <main className="container mx-auto px-4 py-8">
        {/* Search Bar */}
        <div className="mb-8">
          <div className="relative max-w-2xl mx-auto">
            <input
              type="text"
              placeholder="Search your history..."
              className="w-full p-4 pl-12 rounded-lg border border-white/20 bg-white/10 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 placeholder-white/50"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <svg 
              className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white/50" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>
        
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-6">Your Listening History</h1>
          
          {Object.keys(groupedHistory).length > 0 ? (
            <div className="space-y-12">
              {Object.entries(groupedHistory).map(([monthYear, items]) => (
                <div key={monthYear}>
                  <h2 className="text-xl font-semibold mb-4 border-b border-white/20 pb-2">{monthYear}</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                    {items!.map(item => renderHistoryItem(item))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 bg-white/5 backdrop-blur-sm rounded-xl">
              <svg className="w-16 h-16 text-white/40 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="text-xl font-medium text-white mb-2">No history found</h3>
              <p className="text-white/60">Try searching for something else or start listening to podcasts</p>
            </div>
          )}
        </div>
      </main>
      
      <MiniPlayer />
    </div>
  );
} 