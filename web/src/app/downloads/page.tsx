"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import MiniPlayer from "@/components/MiniPlayer";
import { usePlayer } from "@/context/PlayerContext";
import { openDB, DBSchema } from 'idb';
import { getName } from "@tauri-apps/api/app";

// Define DB schema types to match with app/page.tsx
interface PodcastDBSchema extends DBSchema {
  podcasts: {
    key: string;
    value: {
      id: string;
      savedOffline: boolean;
      savedAt: number;
      [key: string]: any;
    };
  };
  assets: {
    key: string;
    value: {
      url: string;
      blob: Blob;
      type: string;
      timestamp: number;
    };
  };
}

// Initialize the IndexedDB database
const initDB = async () => {
  return openDB<PodcastDBSchema>('podcastDB', 1, {
    upgrade(db) {
      // Create stores for podcast data (should match the one in app/page.tsx)
      if (!db.objectStoreNames.contains('podcasts')) {
        db.createObjectStore('podcasts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'url' });
      }
    },
  });
};

// Function to load asset from IndexedDB 
const loadAsset = async (url: string, type: string): Promise<string | null> => {
  if (!url) return null;
  
  try {
    const db = await initDB();
    const storedAsset = await db.get('assets', url);
    
    // If asset exists, use it
    if (storedAsset && storedAsset.blob) {
      return URL.createObjectURL(storedAsset.blob);
    }
    
    // Fallback to network URL
    return url;
  } catch (error) {
    console.error(`Error loading ${type}:`, error);
    return url;
  }
};

// Function to load a podcast from storage with assets
const loadPodcastFromStorage = async (podcastId: string): Promise<any | null> => {
  if (!podcastId) return null;
  
  try {
    const db = await initDB();
    const podcast = await db.get('podcasts', podcastId);
    
    if (!podcast) return null;
    
    // Load assets from storage
    if (podcast.image_url) {
      const coverImageUrl = await loadAsset(podcast.image_url, 'image');
      if (coverImageUrl) {
        podcast.image_url = coverImageUrl;
      }
    }
    
    return podcast;
  } catch (error) {
    console.error('Error loading podcast from storage:', error);
    return null;
  }
};

// Function to get all podcasts saved offline
const getAllSavedPodcasts = async (): Promise<any[]> => {
  try {
    const db = await initDB();
    const podcasts = await db.getAll('podcasts');
    return podcasts.filter(podcast => podcast.savedOffline) || [];
  } catch (error) {
    console.error('Error getting saved podcasts:', error);
    return [];
  }
};

// Function to delete a podcast from offline storage
const deletePodcastFromStorage = async (podcastId: string): Promise<boolean> => {
  if (!podcastId) return false;
  
  try {
    const db = await initDB();
    const podcast = await db.get('podcasts', podcastId);
    
    if (!podcast) return false;
    
    // Remove the podcast from the database
    await db.delete('podcasts', podcastId);
    
    // Delete associated assets
    if (podcast.image_url) {
      await db.delete('assets', podcast.image_url);
    }
    if (podcast.audio_url) {
      await db.delete('assets', podcast.audio_url);
    }
    if (podcast.transcript_url) {
      await db.delete('assets', podcast.transcript_url);
    }
    
    return true;
  } catch (error) {
    console.error('Error deleting podcast from storage:', error);
    return false;
  }
};

// Helper function to format date
const formatDate = (timestamp: number) => {
  if (!timestamp) return 'Unknown date';
  
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

// Calculate storage size in MB
const formatStorageSize = (bytes: number) => {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
};

// PodcastItem component (moved outside the main component)
const PodcastItem = ({ 
  podcast, 
  onPodcastClick, 
  onDeletePodcast 
}: { 
  podcast: any, 
  onPodcastClick: (id: string) => void, 
  onDeletePodcast: (id: string, e: React.MouseEvent) => void 
}) => {
  const [coverImageUrl, setCoverImageUrl] = useState<string>(podcast.image_url);
  
  // Load the cover image from local storage when component mounts
  useEffect(() => {
    const loadCoverImage = async () => {
      const url = await loadAsset(podcast.image_url, 'image');
      if (url) {
        setCoverImageUrl(url);
      }
    };
    
    loadCoverImage();
    
    // Cleanup function to revoke object URL when component unmounts
    return () => {
      if (coverImageUrl && coverImageUrl.startsWith('blob:')) {
        URL.revokeObjectURL(coverImageUrl);
      }
    };
  }, [podcast.image_url, coverImageUrl]);
  
  return (
    <div 
      className="bg-white/10 backdrop-blur-sm rounded-lg shadow-md overflow-hidden cursor-pointer hover:shadow-lg transition-all hover:bg-white/20 group"
      onClick={() => onPodcastClick(podcast.id)}
    >
      <div className="relative aspect-square">
        <Image
          src={coverImageUrl?.startsWith('http') ? coverImageUrl : process.env.NEXT_PUBLIC_BACKEND_URL + `files/${coverImageUrl}`}
          alt={podcast.title || ''}
          width={300}
          height={300}
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <button className="bg-amber-500 hover:bg-amber-600 text-white p-3 rounded-full transform scale-0 group-hover:scale-100 transition-transform">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            </svg>
          </button>
        </div>
        
        {/* Delete button */}
        <button 
          className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white p-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => onDeletePodcast(podcast.id, e)}
          aria-label="Delete download"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="p-4">
        <h3 className="font-medium text-white text-sm line-clamp-1">{podcast.title}</h3>
        <p className="text-white/70 text-xs mb-1">{podcast.show || podcast.subcategory}</p>
        <div className="flex justify-between items-center mt-2">
          <span className="text-white/50 text-xs">Downloaded: {formatDate(podcast.savedAt)}</span>
          <span className="text-amber-400 text-xs">{podcast.duration ? `${Math.floor(parseInt(podcast.duration) / 60)} min` : ''}</span>
        </div>
      </div>
    </div>
  );
};

export default function DownloadsPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [downloadsData, setDownloadsData] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [totalStorage, setTotalStorage] = useState(0);
  const router = useRouter();
  const { setCurrentPodcast } = usePlayer();
  const [tauri, setTauri] = useState(false)
  
  // Load downloads on mount
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
    const loadDownloads = async () => {
      setIsLoading(true);
      try {
        // Get all saved podcasts
        const downloads = await getAllSavedPodcasts();
        
        // For each podcast, load their assets
        const downloadsWithAssets = await Promise.all(
          downloads.map(async (podcast) => {
            // Load cover image from local storage
            if (podcast.image_url) {
              const coverUrl = await loadAsset(podcast.image_url, 'image');
              if (coverUrl) {
                podcast.image_url = coverUrl;
              }
            }
            
            // TODO: We could also preload audio and transcript, but that might be excessive
            // Only necessary if we want to show additional metadata
            
            return podcast;
          })
        );
        
        setDownloadsData(downloadsWithAssets);
        
        // Calculate total storage used
        let total = 0;
        for (const podcast of downloads) {
          // Estimate size based on duration (very rough estimate)
          // Assuming 1MB per minute of audio
          if (podcast.duration) {
            const durationMin = parseInt(podcast.duration) / 60;
            total += durationMin * 1024 * 1024; // MB to bytes
          }
        }
        setTotalStorage(total);
      } catch (error) {
        console.error("Error fetching downloads:", error);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadDownloads();
  }, []);
  
  // Filter downloads based on search term
  const filteredDownloads = downloadsData.filter(item => 
    item.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.show?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.subcategory?.toLowerCase().includes(searchTerm.toLowerCase())
  );
  
  const handlePodcastClick = async (podcastId: string) => {
    try {
      const podcast = await loadPodcastFromStorage(podcastId);
      if (podcast) {
        // Load all assets for this podcast
        if (podcast.image_url) {
          const coverUrl = await loadAsset(podcast.image_url, 'image');
          if (coverUrl) {
            podcast.image_url = coverUrl;
          }
        }
        
        if (podcast.audio_url) {
          const audioUrl = await loadAsset(podcast.audio_url, 'audio');
          if (audioUrl) {
            podcast.audio_url = audioUrl;
          }
        }
        
        if (podcast.transcript_url) {
          const transcriptUrl = await loadAsset(podcast.transcript_url, 'transcript');
          if (transcriptUrl) {
            podcast.transcript_url = transcriptUrl;
          }
        }
        
        setCurrentPodcast(podcast);
        router.push(`/?podcast=${podcastId}`);
      }
    } catch (error) {
      console.error("Error loading podcast:", error);
    }
  };
  
  const handleDeletePodcast = async (podcastId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent from triggering the podcast click
    
    if (confirm('Are you sure you want to delete this downloaded podcast?')) {
      try {
        const success = await deletePodcastFromStorage(podcastId);
        if (success) {
          setDownloadsData(prev => prev.filter(podcast => podcast.id !== podcastId));
          // Recalculate storage
          setTotalStorage(prev => {
            const deletedPodcast = downloadsData.find(p => p.id === podcastId);
            if (deletedPodcast?.duration) {
              const durationMin = parseInt(deletedPodcast.duration) / 60;
              return prev - (durationMin * 1024 * 1024);
            }
            return prev;
          });
        }
      } catch (error) {
        console.error("Error deleting podcast:", error);
      }
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
            <Link href="/library" className="text-white/80 hover:text-white">Library</Link>
            <Link href="/downloads" className="text-white font-medium">Downloads</Link>
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
        {/* Search Bar */}
        <div className="mb-8">
          <div className="relative max-w-2xl mx-auto">
            <input
              type="text"
              placeholder="Search your downloads..."
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
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-3xl font-bold">Your Downloads</h1>
            <div className="text-white/70">
              <span>{downloadsData.length} podcasts</span>
              <span className="mx-2">•</span>
              <span>{formatStorageSize(totalStorage)} used</span>
            </div>
          </div>
          
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="bg-white/5 rounded-lg h-72 animate-pulse"></div>
              ))}
            </div>
          ) : filteredDownloads.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {filteredDownloads.map(podcast => (
                <PodcastItem 
                  key={podcast.id}
                  podcast={podcast} 
                  onPodcastClick={handlePodcastClick}
                  onDeletePodcast={handleDeletePodcast}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-12 bg-white/5 backdrop-blur-sm rounded-xl">
              <svg className="w-16 h-16 text-white/40 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <h3 className="text-xl font-medium text-white mb-2">No downloads found</h3>
              {searchTerm ? (
                <p className="text-white/60">Try searching for something else</p>
              ) : (
                <p className="text-white/60">
                  Download podcasts to listen offline by clicking the download button while playing a podcast
                </p>
              )}
            </div>
          )}
        </div>
      </main>
      
      <MiniPlayer />
    </div>
  );
} 