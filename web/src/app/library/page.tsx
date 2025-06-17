"use client";
import { useState, useEffect, Key } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import MiniPlayer from "@/components/MiniPlayer";
import { usePlayer } from "@/context/PlayerContext";
import { ReactNode, ReactElement, JSXElementConstructor, ReactPortal } from 'react';
import { getName } from "@tauri-apps/api/app";

interface Podcast {
  id: string;
  title: string;
  category: string;
  subcategory: string;
  duration: number;
  duration_seconds: number;
  listen_duration_seconds: number;
  image_url: string;
  positive_rating: number;
  negative_rating: number;
  total_rating: number;
  createAt: string;
  favorite: boolean;
  transcript_url: string;
  published_at?: number;
  [key: string]: any;
}

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
// Mock recommendation API cal

export default function LibraryPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [showTrending, setShowTrending] = useState(false);
  const [trendingItems, setTrendingItems] = useState<Podcast[]>([]);
  const router = useRouter();
  const { setCurrentPodcast, togglePlayPause, playlists, addToPlaylist, createPlaylist, deletePlaylist, setAutoPlay } = usePlayer();
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [selectedPodcast, setSelectedPodcast] = useState<Podcast | null>(null);
  const [filteredPodcasts, setFilteredPodcasts] = useState<Podcast[]>([]);
  const [recommendations, setRecommendations] = useState<Podcast[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingHotTrending, setIsLoadingHotTrending] = useState(true);
  const [history, setHistory] = useState<Podcast[]>([]);
  const [hotTrending, setHotTrending] = useState<Podcast[]>([]);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  
  // Summary feature state
  const [summaryList, setSummaryList] = useState<string[]>([]);
  const [isCreatingSummary, setIsCreatingSummary] = useState(false);

  const [tauri, setTauri] = useState(false)
  
  // Load recommendations on mount
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
    
    const loadRecommendations = async () => {
      
      try {
        fetchRecommendations();
        fetchHistory();
        fetchHotTrending();
      } catch (error) {
        console.error("Error fetching recommendations:", error);
      }
    };
    
    loadRecommendations();
  }, []);

  const fetchRecommendations = async () => {
    // In a real app, this would be an API call
    setIsLoading(true);
    return new Promise(resolve => {
      setTimeout(async () => {
        try {
          const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "recommendations", {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${localStorage.getItem('authToken')}`
            }
            // cache: 'no-store',
            // credentials: 'same-origin'
          })

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const data = await response.json();
          // Ensure data is an array
          setRecommendations(Array.isArray(data) ? data : []);
        } catch (error) {
          console.error("Error fetching recommendations:", error);
          // Set empty array on error
          setRecommendations([]);
        } finally {
          setIsLoading(false);
        }
        resolve([]);
      }, 500);
      
    });
  };
  

  const fetchHistory = async () => {
    return new Promise(resolve => {
      setTimeout(async () => {
        const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "history", {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${localStorage.getItem('authToken')}`
          }
          // cache: 'no-store',
          // credentials: 'same-origin'
        })

        const data = await response.json();
        setHistory(data);
        resolve(data);
      }, 500);
    });
  }

  const fetchHotTrending = async () => {
    setIsLoadingHotTrending(true);
    return new Promise(resolve => {
      setTimeout(async () => {
        const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "trending", {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${localStorage.getItem('authToken')}`
          }
          // cache: 'no-store',
          // credentials: 'same-origin'
        })

        const data = await response.json();
        setHotTrending(data);
        setIsLoadingHotTrending(false);
        resolve(data);
      }, 500);
    });
  }

  const searchPodcasts = async () => {
    if (searchTerm.length <= 0) return;

    const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "search?q=" + searchTerm , {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${localStorage.getItem('authToken')}`
      }
      // cache: 'no-store',
      // credentials: 'same-origin'
    });
    const data = await response.json();
    setFilteredPodcasts(data);
  };
  
  
  
  const handlePodcastClick = (podcastId: Key | null | undefined) => {
    setAutoPlay(false);
    router.push(`/?podcast=${podcastId}`);
  };
  
  // Add podcast to summary list
  const addToSummary = (podcastId: string) => {
    setSummaryList(prev => {
      if (prev.includes(podcastId)) return prev; // No duplicates
      if (prev.length >= 10) return prev; // Max 10 items
      return [...prev, podcastId];
    });
  };
  
  // Remove podcast from summary list
  const removeFromSummary = (podcastId: string) => {
    setSummaryList(prev => prev.filter(id => id !== podcastId));
  };
  
  // Create summary podcast
  const createSummary = async () => {
    if (summaryList.length === 0) return;

    setAutoPlay(false);
    
    setIsCreatingSummary(true);
    try {
      console.log('Creating summary with podcast IDs:', summaryList);
      
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}summary`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        },
        body: JSON.stringify({
          pids: summaryList
        }),
        cache: 'no-cache',
        credentials: 'same-origin'
      });
      
      if (response.ok) {
        const summaryPodcast = await response.json();
        
        if (!summaryPodcast.id) {
          console.error('Backend returned summary podcast without ID:', summaryPodcast);
          alert('Error: Backend did not return a valid podcast ID');
          return;
        }
        
        // Clear the summary list
        setSummaryList([]);
        
        // Navigate to main page with the summary podcast
        const targetUrl = `/?podcast=${summaryPodcast.id}`;
        console.log('Navigating to:', targetUrl);
        
        // Use window.location.href to ensure proper URL update
        window.location.href = targetUrl;
      } else {
        const errorText = await response.text();
        console.error('Failed to create summary. Status:', response.status, 'Response:', errorText);
        alert(`Failed to create summary: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      console.error('Error creating summary:', error);
      alert(`Error creating summary: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsCreatingSummary(false);
    }
  };

  // Render a podcast card with summary button
  const renderPodcastCard = (podcast: Podcast) => {
    const podcastId = podcast.id as string;
    const isInSummary = summaryList.includes(podcastId);
    
    return (
      <div 
        key={podcast.id}
        className="bg-white rounded-xl shadow-lg overflow-hidden cursor-pointer transform transition-all hover:scale-105 hover:shadow-xl relative group"
        onClick={() => handlePodcastClick(podcast.id)}
      >
        <div className="relative aspect-square">
          <Image
            src={podcast.image_url?.startsWith('http') ? podcast.image_url : process.env.NEXT_PUBLIC_BACKEND_URL + `files/${podcast.image_url}`}
            alt={podcast.title?.toString() || ''}
            fill
            unoptimized
            sizes="(max-width: 768px) 100vw, 50vw"
            className="object-cover"
          />
            {/* Add to summary button */}
            <button 
              className={`absolute top-2 left-2 bg-white rounded-full p-2 shadow-md transition-colors ${
                isInSummary 
                  ? 'bg-blue-500 text-white' 
                  : 'bg-white text-blue-600 hover:bg-blue-100'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                if (isInSummary) {
                  removeFromSummary(podcastId);
                } else {
                  addToSummary(podcastId);
                }
              }}
              title={isInSummary ? "Remove from summary" : "Add to summary"}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </button>

            <button 
              className="absolute top-2 right-2 bg-white rounded-full p-2 shadow-md hover:bg-amber-100 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedPodcast(podcast);
                setShowPlaylistModal(true);
              }}
            >
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
            </button>
        </div>
        <div className="p-4">
          <h3 className="font-bold text-lg mb-1 line-clamp-1 text-gray-800">{podcast.title}</h3>
          <p className="text-gray-600 text-sm mb-1">{podcast.subcategory}</p>
          <div className="flex justify-between text-xs text-gray-500">
            <span>{toDate(podcast.published_at || 0)}</span>
          </div>
        </div>
      </div>
    );
  };
  
  // Render a history item
  const renderHistoryItem = (item: any) => (
    <div 
      key={item.id}
      className="flex-shrink-0 w-48 bg-white rounded-lg shadow-md overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
      onClick={() => handlePodcastClick(item.id)}
    >
      <div className="relative h-32">
        <Image
          src={item.image_url?.startsWith('http') ? item.image_url : process.env.NEXT_PUBLIC_BACKEND_URL + `files/${item.image_url}`}
          alt={item.title}
          fill
          unoptimized
          sizes="(max-width: 768px) 100vw, 50vw"
          className="object-cover"
        />
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-200">
          <div 
            className="h-full bg-amber-500"
            style={{ width: `${item.stop_position_seconds / item.duration_seconds * 100}%` }}
          />
        </div>
      </div>
      <div className="p-3">
        <h3 className="font-medium text-sm line-clamp-1 text-gray-800">{item.title}</h3>
        <div className="flex justify-between text-xs text-gray-500">
          <span>{toDate(item.listened_at)}</span>
        </div>
      </div>

    </div>
  );
  
  // Render a trending podcast card with summary button
  const renderTrendingCard = (podcast: Podcast) => {
    const isInSummary = summaryList.includes(podcast.id);
    
    return (
      <div 
        key={podcast.id}
        className="flex-shrink-0 w-48 bg-white rounded-lg shadow-md overflow-hidden cursor-pointer hover:shadow-lg transition-shadow relative group"
        onClick={() => handlePodcastClick(podcast.id)}
      >
        <div className="relative h-32">
          <Image
            src={podcast.image_url?.startsWith('http') ? podcast.image_url : process.env.NEXT_PUBLIC_BACKEND_URL + `files/${podcast.image_url}`}
            alt={podcast.title}
            fill
            unoptimized
            sizes="(max-width: 768px) 100vw, 50vw"
            className="object-cover"
          />
          
          {/* Summary button for trending cards */}
          <button 
            className={`absolute top-2 left-2 rounded-full p-1.5 shadow-md transition-colors z-10 ${
              isInSummary 
                ? 'bg-blue-500 text-white' 
                : 'bg-white text-blue-600 hover:bg-blue-100'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (isInSummary) {
                removeFromSummary(podcast.id);
              } else {
                addToSummary(podcast.id);
              }
            }}
            title={isInSummary ? "Remove from summary" : "Add to summary"}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </button>

          {/* Add to playlist button (top-right) */}
          <button 
            className="absolute top-2 right-2 bg-white rounded-full p-1.5 shadow-md hover:bg-amber-100 transition-colors z-10"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedPodcast(podcast);
              setShowPlaylistModal(true);
            }}
          >
            <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </button>
        </div>
        <div className="p-3">
          <h3 className="font-medium text-sm line-clamp-1 text-gray-800">{podcast.title}</h3>
          <p className="text-xs text-gray-500 line-clamp-1">{toDate(podcast.published_at ? podcast.published_at : '')}</p>
        </div>
      </div>
    );
  };
  
  // Add new function to fetch trending items
  const fetchTrending = async () => {
    try {
      const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "get_trending", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      const data = await response.json();
      setTrendingItems(data);
    } catch (error) {
      console.error("Error fetching trending items:", error);
    }
  };

  return (
    <div className={`min-h-screen bg-gradient-to-br from-indigo-900/90 to-purple-900/90 text-white ${tauri ? 'mt-8' : ''}`}>
      <header className="bg-white/10 backdrop-blur-md shadow-lg">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Link href="/" className="text-2xl font-bold text-white">BriefCast</Link>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-white/80 hover:text-white">Player</Link>
            <Link href="/library" className="text-white font-medium">Library</Link>
            <Link href="/downloads" className="text-white/80 hover:text-white">Downloads</Link>
            <Link href="/history" className="text-white/80 hover:text-white">History</Link>
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
        {/* Search Bar with Trending Dropdown */}
        <div className="mb-8">
          <div className="relative max-w-2xl mx-auto">
            <input
              type="text"
              placeholder="Search podcasts..."
              className="w-full p-4 pl-12 rounded-lg border border-white/20 bg-white/10 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 placeholder-white/50"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  searchPodcasts();
                }
              }}
              onFocus={() => {
                setShowTrending(true);
                fetchTrending();
              }}
              onBlur={() => {
                // Delay hiding to allow clicking on trending items
                setTimeout(() => setShowTrending(false), 200);
              }}
            />
            <svg 
              className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white/50" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>

            {/* Trending Dropdown */}
            {showTrending && trendingItems.length > 0 && (
              <div className="absolute z-50 w-full mt-2 bg-white/10 backdrop-blur-md rounded-lg shadow-xl border border-white/20 max-h-96 overflow-y-auto">
                <div className="p-2">
                  <h3 className="text-sm font-semibold text-white/80 mb-2 px-2">Trending Now</h3>
                  {trendingItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/20 cursor-pointer"
                      onClick={() => {
                        setSearchTerm(item.title);
                        setShowTrending(false);
                        searchPodcasts();
                      }}
                    >
                      <div className="relative w-10 h-10 flex-shrink-0">
                        <Image
                          src={item.image_url?.startsWith('http') ? item.image_url : process.env.NEXT_PUBLIC_BACKEND_URL + `files/${item.image_url}`}
                          alt={item.title?.toString() || ''}
                          fill
                          unoptimized
                          sizes="(max-width: 768px) 100vw, 50vw"
                          className="object-cover rounded-md"
                        />
                      </div>
                      <div className="flex-grow min-w-0">
                        <h4 className="text-white font-medium truncate">{item.title}</h4>
                        <p className="text-sm text-white/60 truncate">{item.category} | {item.subcategory}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        
        {filteredPodcasts.length > 0 ? (
          // Search Results
          <div className="mb-8">
            <h2 className="text-2xl font-bold mb-6">Search Results</h2>
            
            {filteredPodcasts.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredPodcasts.map(podcast => renderPodcastCard(podcast))}
              </div>
            ) : (
              <div className="text-center py-12 bg-white/10 backdrop-blur-sm rounded-xl">
                <svg className="w-16 h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <h3 className="text-xl font-medium text-gray-700 mb-2">No podcasts found</h3>
                <p className="text-gray-500">Try searching for something else</p>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* History Section */}
            <section className="mb-4">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-bold">Recently Played</h2>
                <Link 
                  href="/history" 
                  className="text-amber-600 hover:text-amber-700 flex items-center gap-1"
                >
                  See all
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
              
              <div className="flex overflow-x-auto gap-4 pb-4 -mx-4 px-4">
                {history.slice(0, 10).map(item => renderHistoryItem(item))}
              </div>
            </section>

            {/* Hot Trending Section */}
            <section className="mb-4">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-bold">Hot Trending</h2>
                <span className="text-amber-600 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M12.395 2.553a1 1 0 00-1.45-.385c-.345.23-.614.558-.822.88-.214.33-.403.713-.57 1.116-.334.804-.614 1.768-.84 2.734a31.365 31.365 0 00-.613 3.58 2.64 2.64 0 01-.945-1.067c-.328-.68-.398-1.534-.398-2.654A1 1 0 005.05 6.05 6.981 6.981 0 003 11a7 7 0 1011.95-4.95c-.592-.591-.98-.985-1.348-1.467-.363-.476-.724-1.063-1.207-2.03zM12.12 15.12A3 3 0 017 13s.879.5 2.5.5c0-1 .5-4 1.25-4.5.5 1 .786 1.293 1.371 1.879A2.99 2.99 0 0113 13a2.99 2.99 0 01-.879 2.121z" clipRule="evenodd" />
                  </svg>
                  Trending Now
                </span>
              </div>
              
              {isLoadingHotTrending ? (
                <div className="flex overflow-x-auto gap-4 pb-4 -mx-4 px-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex-shrink-0 w-48 bg-white/20 rounded-lg h-32 animate-pulse"></div>
                  ))}
                </div>
              ) : (
                <div className="flex overflow-x-auto gap-4 pb-4 -mx-4 px-4">
                  {hotTrending.map(podcast => renderTrendingCard(podcast))}
                </div>
              )}
            </section>
            
            {/* For You Section */}
            <section className="mb-4">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-bold">For You</h2>
                <button 
                  onClick={fetchRecommendations} 
                  className="text-amber-600 hover:text-amber-700 flex items-center gap-1"
                >
                  Refresh
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </div>
              
              {isLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {[...Array(8)].map((_, i) => (
                    <div key={i} className="bg-white/20 rounded-xl h-64 animate-pulse"></div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {(recommendations && Array.isArray(recommendations) && recommendations.length > 0) ? (
                    recommendations.map(podcast => renderPodcastCard(podcast))
                  ) : (
                    <div className="col-span-full text-center py-12 bg-white/10 backdrop-blur-sm rounded-xl">
                      <svg className="w-16 h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <h3 className="text-xl font-medium text-gray-300 mb-2">No recommendations available</h3>
                      <p className="text-gray-400">Try refreshing to get new recommendations</p>
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </main>
      
      <MiniPlayer />
      
      {showPlaylistModal && selectedPodcast && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-indigo-900 border border-white/20 rounded-lg p-6 w-full max-w-md text-white">
            <h3 className="text-xl font-bold mb-4">Add to Playlist</h3>
            
            <div className="space-y-2 mb-4">
              {playlists?.map(playlist => (
                <button
                  key={playlist.id}
                  className="w-full text-left p-3 rounded-lg hover:bg-amber-600 flex justify-between items-center"
                  onClick={async () => {
                    addToPlaylist(playlist.id, {
                      ...selectedPodcast,
                      duration: String(selectedPodcast.duration),
                      positive: 0,
                      totalRating: 0,
                      show: '',
                      episode: '',
                      audio_url: selectedPodcast.audio_url || '',
                      published_at: selectedPodcast.published_at || Date.now(),
                      added_at: Date.now().toString()
                    });
                    setShowPlaylistModal(false);
                  }}
                >
                  <span>{playlist.name}</span>
                  {playlist.id !== 'favorite' && playlist.id !== 'like' && (<button 
                    className="text-gray-400 hover:text-red-500"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await deletePlaylist(playlist.id);
                    }}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>)}
                </button>
              ))}
            </div>
            
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Create New Playlist
              </label>
              <input
                type="text"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                placeholder="Enter playlist name"
                className="w-full px-3 py-2 rounded-md bg-white/10 text-white placeholder-gray-400 border border-white/20 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>
            
            <div className="flex justify-between">
              <button
                className="text-gray-500 hover:text-gray-300"
                onClick={() => setShowPlaylistModal(false)}
              >
                Cancel
              </button>
              
              <button
                className="bg-amber-500 text-white px-4 py-2 rounded-lg hover:bg-amber-600"
                onClick={async () => {
                  try {
                    const playlistName = newPlaylistName.trim() || `New Playlist ${(playlists?.length || 0) + 1}`;
                    const newPlaylistId = await createPlaylist(playlistName);
                    await addToPlaylist(newPlaylistId, {
                      ...selectedPodcast,
                      duration: String(selectedPodcast.duration),
                      positive: 0,
                      totalRating: 0,
                      show: '',
                      episode: '',
                      audio_url: '',
                      published_at: selectedPodcast?.published_at || Date.now(),
                      added_at: Date.now().toString()
                    });
                    setNewPlaylistName('');
                    setShowPlaylistModal(false);
                  } catch (error) {
                    console.error("Error creating playlist:", error);
                  }
                }}
              >
                Create Playlist
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Summary Creation Button - Fixed at bottom when summary list has items */}
      {summaryList.length > 0 && (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-50">
          <button
            onClick={createSummary}
            disabled={isCreatingSummary}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-6 py-3 rounded-full shadow-lg flex items-center gap-2 transition-colors"
          >
            {isCreatingSummary ? (
              <>
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Creating Summary...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Create Summary ({summaryList.length}/10)
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
} 