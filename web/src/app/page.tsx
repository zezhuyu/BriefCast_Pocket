"use client"
import Image from "next/image";
import { useMemo, useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { usePlayer } from "@/context/PlayerContext";
import Playlist from '@/components/Playlist';
import { motion, AnimatePresence } from "framer-motion";
import { convertLRCToTranscriptData } from "@/utils/lrcParser";
// Import for IndexedDB operations
import { openDB, DBSchema } from 'idb';
import { getName } from "@tauri-apps/api/app";

// Extend the Window interface to include our functions
declare global {
  interface Window {
    isPodcastAvailableOffline?: (podcastId: string) => Promise<boolean>;
    loadAsset?: (url: string, type: string) => Promise<string | null>;
    savePodcastOffline?: (podcast: any) => Promise<boolean>;
    loadPodcastFromStorage?: (podcastId: string) => Promise<any | null>;
    deletePodcastFromStorage?: (podcastId: string) => Promise<boolean>;
  }
}

// Define DB schema types
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

const parseDateString = (timestamp: string | number): Date => {
  if (timestamp === undefined) return new Date();
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

// Initialize the IndexedDB database
const initDB = async () => {
  return openDB<PodcastDBSchema>('podcastDB', 1, {
    upgrade(db) {
      // Create stores for podcast data
      if (!db.objectStoreNames.contains('podcasts')) {
        db.createObjectStore('podcasts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'url' });
      }
    },
  });
};

// Function to download and store a file as blob
const downloadAsset = async (url: string, type: string): Promise<Blob | null> => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    
    // Store in IndexedDB
    const db = await initDB();
    await db.put('assets', { 
      url,
      blob,
      type,
      timestamp: Date.now()
    });
    
    return blob;
  } catch (error) {
    console.error(`Error downloading ${type}:`, error);
    return null;
  }
};

// Function to load asset from IndexedDB or network
const loadAsset = async (url: string, type: string): Promise<string | null> => {
  if (!url) return null;
  
  try {
    const db = await initDB();
    const storedAsset = await db.get('assets', url);
    
    // If asset exists and is less than 7 days old, use it
    if (storedAsset && (Date.now() - storedAsset.timestamp < 7 * 24 * 60 * 60 * 1000)) {
      return URL.createObjectURL(storedAsset.blob);
    }
    
    // Otherwise download it
    const blob = await downloadAsset(url, type);
    if (blob) {
      return URL.createObjectURL(blob);
    }
    
    // Fallback to network URL
    return url;
  } catch (error) {
    console.error(`Error loading ${type}:`, error);
    return url;
  }
};

// Function to save complete podcast data for offline use
const savePodcastOffline = async (podcast: any): Promise<boolean> => {
  if (!podcast) return false;
  
  try {
    // Download all assets
    const coverImagePromise = downloadAsset(podcast.image_url, 'image');
    const audioPromise = downloadAsset(podcast.audio_url, 'audio');
    const transcriptPromise = downloadAsset(podcast.transcript_url, 'transcript');
    
    await Promise.all([coverImagePromise, audioPromise, transcriptPromise]);
    
    // Store podcast metadata
    const db = await initDB();
    await db.put('podcasts', { 
      ...podcast,
      savedOffline: true,
      savedAt: Date.now()
    });
    
    return true;
  } catch (error) {
    console.error('Error saving podcast offline:', error);
    return false;
  }
};

// Function to check if podcast is available offline
const isPodcastAvailableOffline = async (podcastId: string): Promise<boolean> => {
  if (!podcastId) return false;
  
  try {
    const db = await initDB();
    const podcast = await db.get('podcasts', podcastId);
    return !!podcast?.savedOffline;
  } catch (error) {
    console.error('Error checking offline availability:', error);
    return false;
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

// Function to manually trigger loading assets from IndexedDB
const loadPodcastFromStorage = async (podcastId: string): Promise<any | null> => {
  if (!podcastId) return null;
  
  try {
    const db = await initDB();
    const podcast = await db.get('podcasts', podcastId);
    
    if (!podcast) return null;
    
    // Load assets from storage
    const coverImageUrl = await loadAsset(podcast.image_url, 'image');
    const audioUrl = await loadAsset(podcast.audio_url, 'audio');
    const transcriptUrl = await loadAsset(podcast.transcript_url, 'transcript');
    
    return {
      ...podcast,
      image_url: coverImageUrl,
      audio_url: audioUrl,
      transcript_url: transcriptUrl
    };
  } catch (error) {
    console.error('Error loading podcast from storage:', error);
    return null;
  }
};

// Function to get user location
function getLocation(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject);
  });
}

const toMinutes = (seconds: number) => {
  if (seconds < 60) {
    return Math.floor(seconds) + " Seconds";
  }else if (seconds < 3600) {
    return Math.floor(seconds / 60) + " Minutes";
  }else if (seconds < 86400) {
    return Math.floor(seconds / 3600) + " Hours";
  }
}

// Add component for offline indicator
const OfflineIndicator = ({ isOnline }: { isOnline: boolean }) => {
  if (isOnline) return null;
  
  return (
    <div className="fixed top-0 left-0 right-0 bg-red-600 text-white px-4 py-2 text-center z-50 flex items-center justify-center">
      <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>You are offline. Only downloaded podcasts are available.</span>
    </div>
  );
};

export default function Home() {
  // Add this near the top of the component
  useEffect(() => {
    // Monitor online/offline status
    const updateOnlineStatus = () => {
      setIsOnline(navigator.onLine);
    };
    
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    
    // Check initial status
    updateOnlineStatus();
    
    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  // Add a version timestamp to bust browser cache
  useEffect(() => {
    const appVersion = Date.now();
    
    // Force reload if cached version detected
    const lastVersion = localStorage.getItem('appVersion');
    if (lastVersion) {
      const versionDiff = appVersion - parseInt(lastVersion);
      
      // If cached for more than 5 minutes, force reload
      if (versionDiff > 5 * 60 * 1000) {
        localStorage.setItem('appVersion', appVersion.toString());
        window.location.reload(); // Force reload
        return;
      }
    }
    
    localStorage.setItem('appVersion', appVersion.toString());
  }, []);

  // Keep local state for UI elements
  const [colors, setColors] = useState({
    primary: 'rgb(100, 34, 254)',    // amber-500 - primary accent color
    secondary: 'rgb(36, 63, 238)',   // amber-600 - secondary accent color
    tertiary: 'rgb(79, 70, 229)'     // indigo-600 - complementary to the background
  });
  
  // Helper function to create cache-busting URLs
  const getNoCacheUrl = (url: string) => {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}_nocache=${Date.now()}`;
  };

  function getCoverImageUrl(url: string | undefined) {
    if (!url) return '';
    if (url.startsWith("http") || url.startsWith('blob:')) return url;
    return (process.env.NEXT_PUBLIC_BACKEND_URL || '') + 'files/' + url;
  }
  const transcriptRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [hoverPosition, setHoverPosition] = useState(-1);
  const [userScrolling, setUserScrolling] = useState(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isDisliked, setIsDisliked] = useState<boolean>(false);
  const [isLiked, setIsLiked] = useState<boolean>(false);
  const [isFavorite, setIsFavorite] = useState<boolean>(false);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [addToPlaylistPodcast, setAddToPlaylist] = useState<any | null>(null); // Changed PodcastCard to any since type not found
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'transcript' | 'playlist'>('transcript');
  const [showMobileOverlay, setShowMobileOverlay] = useState(false);
  const [mobileView, setMobileView] = useState<'transcript' | 'playlist' | 'player'>('player');
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const [playerHeight, setPlayerHeight] = useState<number | null>(null);
  const [transcriptData, setTranscriptData] = useState<any[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isAvailableOffline, setIsAvailableOffline] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [isTauri, setIsTauri] = useState(false);
  

  // Use the player context
  const { 
    currentPodcast, 
    isPlaying, 
    currentTime, 
    duration, 
    setCurrentPodcast, 
    togglePlayPause, 
    seekTo, 
    formatTime,
    currentPlaylist,
    playPrevious,
    playNext,
    playlists,
    setCurrentPlaylist,
    removeFromPlaylist,
    createPlaylist,
    deletePlaylist,
    setLiked,
    sharePodcast,
    downloadPodcast,
    addToPlaylist,
    logUserAction,
    setPodcastId,
    tmpPlaylist,
    setTmpPlaylist,
    setAutoPlay
  } = usePlayer();

  // Generate random waveform data
  const waveformData = useMemo(() => {
    return Array.from({ length: 100 }, () => Math.random() * 100);
  }, []);

  // Add null check for searchParams
  const searchParams = useSearchParams();
  const router = useRouter();
  
  // Get podcast ID from URL or use empty string to trigger location-based generation
  var podcastId = searchParams?.get('podcast') || "";
  
  // If we have a current podcast but no URL parameter, update URL
  useEffect(() => {
    if (currentPodcast?.id && !searchParams?.get('podcast')) {
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('podcast', currentPodcast.id);
      window.history.replaceState({}, '', newUrl.toString());
    }
  }, [currentPodcast?.id, searchParams]);

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

  // Handle podcast ID changes without page reload
  useEffect(() => {
    // Always call setPodcastId to trigger loading
    // Empty string will trigger location-based generation in PlayerContext
    setPodcastId(podcastId);
  }, [podcastId, setPodcastId]);

  // Find the selected podcast or use the default
  const selectedPodcast = podcastId;

  useEffect(() => {
    const loadTranscript = async (url: string, attempt: number = 1) => {
      try {
        const data = await convertLRCToTranscriptData(url)
        // Transform the data to match the expected format in the scrolling logic
        const formattedData = data.map(item => ({
          time: item.start || 0,  // Add fallback to 0 if start is undefined or null
          text: item.text
        }));
        setTranscriptData(formattedData);
      } catch (error) {
        // Retry up to 3 times with a short delay in between
        if (attempt < 3) {
          setTimeout(() => loadTranscript(url, attempt + 1), 2000);
        } else {
          console.error("Error loading transcript after retries:", error);
        }
      }
    };
    if (currentPodcast?.transcript_url) {
      loadTranscript(currentPodcast.transcript_url);
    } else {
    }
  }, [currentPodcast])

  // Check if current podcast is available offline
  useEffect(() => {
    if (currentPodcast?.id) {
      isPodcastAvailableOffline(currentPodcast.id)
        .then(available => setIsAvailableOffline(available));
    }
  }, [currentPodcast?.id]);

  // Ensure URLs are correctly set when currentPodcast changes
  useEffect(() => {
    if (!currentPodcast) return;
    
    const fixUrls = async () => {
      // Check if podcast is available offline
      const isAvailable = await isPodcastAvailableOffline(currentPodcast.id);
      setIsAvailableOffline(isAvailable);
      
      // If available offline, no need to modify URLs as they should already be blob URLs
      if (isAvailable) return;
      
      // Otherwise ensure URLs are formatted correctly for network resources
      if (currentPodcast.transcript_url && !currentPodcast.transcript_url?.startsWith(process.env.NEXT_PUBLIC_BACKEND_URL || '') && !currentPodcast.transcript_url?.startsWith('blob:')) {
        currentPodcast.transcript_url = process.env.NEXT_PUBLIC_BACKEND_URL + 'files/' + currentPodcast.transcript_url;
      }
      
      if (currentPodcast.audio_url && !currentPodcast.audio_url?.startsWith(process.env.NEXT_PUBLIC_BACKEND_URL || '') && !currentPodcast.audio_url?.startsWith('blob:')) {
        currentPodcast.audio_url = process.env.NEXT_PUBLIC_BACKEND_URL + 'files/' + currentPodcast.audio_url;
      }
      
      if (currentPodcast.image_url && !currentPodcast.image_url?.startsWith("http") && !currentPodcast.image_url?.startsWith('/api/') && !currentPodcast.image_url?.startsWith('blob:')) {
        currentPodcast.image_url = process.env.NEXT_PUBLIC_BACKEND_URL + 'files/' + currentPodcast.image_url;
      }
    };
    
    fixUrls();
  }, [currentPodcast]);

  // Calculate progress percentage
  const progressPercentage = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Extract vibrant colors for accents - EFFECT 1
  useEffect(() => {
    if (!currentPodcast) return;
    
    const hiddenImg = document.createElement('img');
    hiddenImg.crossOrigin = "Anonymous";
    if (!currentPodcast.image_url?.startsWith("http") && !currentPodcast.image_url?.startsWith('/api/') && !currentPodcast.image_url?.startsWith('blob:')) {
      currentPodcast.image_url = process.env.NEXT_PUBLIC_BACKEND_URL + 'files/' + currentPodcast.image_url;
    }
    hiddenImg.src = currentPodcast.image_url;
    hiddenImg.style.display = 'none';
    document.body.appendChild(hiddenImg);
    
    hiddenImg.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      canvas.width = hiddenImg.width;
      canvas.height = hiddenImg.height;
      ctx.drawImage(hiddenImg, 0, 0, hiddenImg.width, hiddenImg.height);
      
      try {
        // Sample colors from different parts of the image for more variety
        const topLeft = ctx.getImageData(0, 0, 1, 1).data;
        const center = ctx.getImageData(Math.floor(hiddenImg.width/2), Math.floor(hiddenImg.height/2), 1, 1).data;
        const bottomRight = ctx.getImageData(hiddenImg.width - 1, hiddenImg.height - 1, 1, 1).data;
        
        // Set multiple colors for a richer background
        const primary = `rgb(${center[0]}, ${center[1]}, ${center[2]})`;
        const secondary = `rgb(${bottomRight[0]}, ${bottomRight[1]}, ${bottomRight[2]})`;
        const tertiary = `rgb(${topLeft[0]}, ${topLeft[1]}, ${topLeft[2]})`;
        
        setColors({ primary, secondary, tertiary });
      } catch (error) {
        console.error("Error extracting colors:", error);
      }
      
      // Clean up
      // document.body.removeChild(hiddenImg);
    };
    
    return () => {
      if (document.body.contains(hiddenImg)) {
        document.body.removeChild(hiddenImg);
      }
    };
  }, [currentPodcast]);

  // Set the current podcast when it changes - EFFECT 2
  useEffect(() => {
    // if (selectedPodcast && (!currentPodcast || currentPodcast.id !== selectedPodcast.id)) {
    //   setCurrentPodcast(selectedPodcast);
    // }
  }, [selectedPodcast, currentPodcast, setCurrentPodcast]);

  // Add a ref for the mobile transcript container
  const mobileTranscriptRef = useRef<HTMLDivElement>(null);

  // Update the useEffect for transcript scrolling to handle both desktop and mobile views
  useEffect(() => {
    // Get the appropriate transcript container based on the current view
    const container = mobileView === 'transcript' && window.innerWidth < 768
      ? mobileTranscriptRef.current
      : transcriptRef.current;
      
    if (!container || userScrolling || !transcriptData.length) return;
    
    // Find the currently active transcript item
    // Support both data formats (time or start)
    const activeIndex = transcriptData.findIndex((item, i) => {
      const itemTime = 'time' in item ? item.time : item.start;
      const nextItemTime = transcriptData[i+1] 
        ? ('time' in transcriptData[i+1] ? transcriptData[i+1].time : transcriptData[i+1].start) 
        : Infinity;
      
      return currentTime >= itemTime && currentTime < nextItemTime;
    });
    
    if (activeIndex !== -1) {
      // Get all transcript paragraphs
      const paragraphs = container.querySelectorAll('p');
      if (!paragraphs || paragraphs.length === 0) return;
      
      // Get the active element
      const activeElement = paragraphs[activeIndex];
      if (!activeElement) return;
      
      // Get container dimensions
      const containerHeight = container.clientHeight;
      
      // Calculate positions
      const elementTop = activeElement.offsetTop;
      const elementHeight = activeElement.clientHeight;
      
      // Calculate target scroll position with special handling for first/last items
      let targetScrollTop;
      
      if (activeIndex === 0) {
        // First item - position at 1/3 from the top
        targetScrollTop = elementTop - (containerHeight / 3);
      } else if (activeIndex === transcriptData.length - 1) {
        // Last item - position at 2/3 from the top
        targetScrollTop = elementTop - (containerHeight * 2/3);
      } else {
        // Middle items - center in container
        targetScrollTop = elementTop - (containerHeight / 2) + (elementHeight / 2);
      }
      
      // Apply scroll with smooth behavior
      container.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: 'smooth'
      });
    }
  }, [currentTime, transcriptData, userScrolling, mobileView]);

  // Add event handlers to detect user scrolling
  useEffect(() => {
    const desktopContainer = transcriptRef.current;
    const mobileContainer = mobileTranscriptRef.current;
    
    const handleUserScroll = () => {
      // User is scrolling, disable auto-scroll
      setUserScrolling(true);
      
      // Clear any existing timeout
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      
      // Set a timeout to re-enable auto-scroll after 2 seconds of inactivity
      scrollTimeoutRef.current = setTimeout(() => {
        setUserScrolling(false);
      }, 2000);
    };
    
    // Add scroll event listeners to both containers
    if (desktopContainer) {
      desktopContainer.addEventListener('scroll', handleUserScroll);
    }
    
    if (mobileContainer) {
      mobileContainer.addEventListener('scroll', handleUserScroll);
    }
    
    return () => {
      // Clean up
      if (desktopContainer) {
        desktopContainer.removeEventListener('scroll', handleUserScroll);
      }
      
      if (mobileContainer) {
        mobileContainer.removeEventListener('scroll', handleUserScroll);
      }
      
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [mobileTranscriptRef.current, transcriptRef.current]);

  // Update the effect that measures player height
  useEffect(() => {
    const updatePlayerHeight = () => {
      if (playerContainerRef.current) {
        // Get the height of the player container without the navigation
        const playerContent = playerContainerRef.current.querySelector('.flex-grow');
        if (playerContent) {
          const contentHeight = playerContent.getBoundingClientRect().height;
          // Add a small buffer for padding
          setPlayerHeight(contentHeight + 20);
        }
      }
    };

    // Update height when component mounts or when mobile view changes
    updatePlayerHeight();
    
    // Also update on window resize
    window.addEventListener('resize', updatePlayerHeight);
    
    return () => {
      window.removeEventListener('resize', updatePlayerHeight);
    };
  }, [mobileView, currentPodcast]);

  // Add ref for tracking play requests
  const playRequestRef = useRef<number>(0);

  // Handle play request with loading state and error handling
  const handlePlayRequest = async () => {
    try {
      setIsAudioLoading(true);
      setAudioError(null);
      
      // Increment play request counter
      playRequestRef.current += 1;
      const currentRequest = playRequestRef.current;
      
      // Add a small delay to ensure audio is ready
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check if this is still the most recent play request
      if (currentRequest === playRequestRef.current) {
        await togglePlayPause();
      }
    } catch (error) {
      console.error('Playback error:', error);
      setAudioError('Failed to play audio. Please try again.');
    } finally {
      setIsAudioLoading(false);
    }
  };

  // Handle seeking when clicking on waveform
  const handleWaveformClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const waveformRect = event.currentTarget.getBoundingClientRect();
    const clickPosition = (event.clientX - waveformRect.left) / waveformRect.width;
    const newTime = clickPosition * (duration || 0);
    
    seekTo(newTime);
    
    if (!isPlaying) {
      handlePlayRequest();
    }
  };

  // Update the seekToTranscriptTime function to handle invalid time values
  const seekToTranscriptTime = (time: number) => {
    // Ensure time is a valid, finite number
    if (time !== undefined && time !== null && isFinite(time)) {
    seekTo(time);
    setUserScrolling(false); // Reset user scrolling to allow auto-scroll
    } else {
      // If time is invalid, seek to the beginning
      seekTo(0);
      setUserScrolling(false);
    }
  };

  // Add this function to toggle the mobile overlay
  const toggleMobileOverlay = (view: 'transcript' | 'playlist') => {
    if (showMobileOverlay && mobileView === view) {
      setShowMobileOverlay(false);
    } else {
      setMobileView(view);
      setShowMobileOverlay(true);
    }
  };

  // Add a useEffect to handle responsive view changes
  useEffect(() => {
    // Function to check window width and reset view if needed
    const handleResize = () => {
      if (window.innerWidth >= 768 && mobileView !== 'player') {
        setMobileView('player');
      }
    };

    // Add event listener
    window.addEventListener('resize', handleResize);
    
    // Call once on mount to ensure correct initial state
    handleResize();
    
    // Clean up event listener on unmount
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [mobileView]);

  // First, let's add a function to handle the toggle behavior
  const toggleView = (view: 'transcript' | 'playlist') => {
    if (mobileView === view) {
      // If already in this view, toggle back to player
      setMobileView('player');
    } else {
      // Otherwise, switch to the selected view
      setMobileView(view);
    }
  };

  // First, let's update the MobileNavigation component to use absolute positioning
  const MobileNavigation = () => (
    <div className="absolute bottom-0 left-0 right-0 h-16 pt-4 border-t border-white/10 md:hidden">
      <div className="flex justify-around items-center">
        <button
          onClick={() => toggleView('transcript')}
          className={`flex flex-col items-center gap-1 px-4 py-2 ${
            mobileView === 'transcript'
              ? 'text-amber-500'
              : 'text-white/70 hover:text-white'
          }`}
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-xs">Transcript</span>
        </button>
        
        <button
          onClick={() => toggleView('playlist')}
          className={`flex flex-col items-center gap-1 px-4 py-2 ${
            mobileView === 'playlist'
              ? 'text-amber-500'
              : 'text-white/70 hover:text-white'
          }`}
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
          </svg>
          <span className="text-xs">Playlist</span>
        </button>
      </div>
    </div>
  );

  // Check if podcast is in favorites when it changes
  useEffect(() => {
    const checkFavorite = async () => {
      if (currentPodcast) {
        const favoritePlaylist = playlists?.find(p => p.id === 'favorite');
        const isInFavorites =  favoritePlaylist?.podcasts?.some(p => p.id === currentPodcast.id) || false;
        setIsFavorite(isInFavorites || currentPodcast?.favorite || false);
      }
    };
    checkFavorite();
  }, [currentPodcast]);

  // Handle favorite toggle
  const toggleFavorite = async () => {
    if (!currentPodcast) return;
    
    const favoritePlaylist = playlists?.find(p => p.id === 'favorite');
    if (favoritePlaylist) {
      const isInFavorites = favoritePlaylist.podcasts?.some(p => p.id === currentPodcast.id) || false;
      
      if (isFavorite) {
        await removeFromPlaylist('favorite', currentPodcast.id);
        logUserAction('remove_from_playlist', { playlistId: 'favorite' });
      } else {
        await addToPlaylist('favorite', currentPodcast);
        logUserAction('add_to_playlist', { playlistId: 'favorite' });
      }
    }
  };

  // Check if podcast is liked when it changes
  useEffect(() => {
    const checkLiked = async () => {
      if (currentPodcast) {
        const likePlaylist = playlists?.find(p => p.id === 'like');
        const isInLikes = likePlaylist?.podcasts?.some(p => p.id === currentPodcast.id) || false;
        const isCurrentPlaylistLike = currentPlaylist?.id === 'like';
        const isPodcastLiked = currentPodcast.rating === 1;
        setIsLiked(isInLikes || isCurrentPlaylistLike || isPodcastLiked);
      }
    };
    checkLiked();
  }, [currentPodcast, playlists]);

  // Check if podcast is disliked when it changes
  useEffect(() => {
    const checkDisliked = async () => {
      if (currentPodcast) {
        const isPodcastDisliked = currentPodcast.rating === -1;
        setIsDisliked(isPodcastDisliked);
      }
    };
    checkDisliked();
  }, [currentPodcast]);

  // If no podcast is selected yet, show a loading state
  if (!currentPodcast) {
    return (
      <div className={`containermin-h-screen bg-gradient-to-br from-indigo-900/90 to-purple-900/90 text-white ${isTauri ? 'mt-8' : ''}`}>
        <header className=" backdrop-blur-md ">
          <div className="container mx-auto px-4 py-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <Link href="/" className="text-2xl font-bold text-white">BriefCast</Link>
            </div>
            <div className="flex items-center gap-4">
              <Link href="/" className="text-white/80 font-medium">Player</Link>
              <Link href="/library" className="text-white/80 hover:text-white">Library</Link>
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
        <main className="h-screen container max-w-6xl mx-auto px-4 pt-4 pb-12 relative z-10">
        {!isTauri &&
          <h1 className="text-4xl font-bold mb-12 text-center bg-gradient-to-r from-amber-500 to-amber-600 text-transparent bg-clip-text">
            BriefCast
          </h1>}
          
          <div className="flex items-center justify-center h-full">
            Loading...
          </div>
        </main>
      </div>
    );
  }

  // Make offline functions available globally
  if (typeof window !== 'undefined') {
    window.isPodcastAvailableOffline = isPodcastAvailableOffline;
    window.loadAsset = loadAsset;
    window.savePodcastOffline = savePodcastOffline;
    window.loadPodcastFromStorage = loadPodcastFromStorage;
    window.deletePodcastFromStorage = deletePodcastFromStorage;
  }

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Offline Indicator */}
      <OfflineIndicator isOnline={isOnline} />
      
      {/* Base color layer - using rgba with direct opacity values */}
      <div 
        className="absolute inset-0 w-full h-full"
        style={{ 
          background: `linear-gradient(145deg, ${colors.primary}, ${colors.secondary})`,
          opacity: 0.8
        }}
      />
      
      {/* Replace the animated background elements with this improved version */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Primary color blob */}
        <motion.div 
          className="absolute -top-[20%] -left-[10%] w-[80%] h-[80%] rounded-full opacity-30 blur-[100px]"
          style={{ 
            background: `radial-gradient(circle at center, ${colors.primary}, transparent 70%)` 
          }}
          animate={{
            x: [0, 30, -20, 0],
            y: [0, -40, 20, 0],
            scale: [1, 1.1, 0.9, 1]
          }}
          transition={{
            duration: 25,
            repeat: Infinity,
            repeatType: "reverse",
            ease: "easeInOut"
          }}
        />
        
        {/* Secondary color blob */}
        <motion.div 
          className="absolute -bottom-[30%] -right-[20%] w-[90%] h-[90%] rounded-full opacity-30 blur-[120px]"
          style={{ 
            background: `radial-gradient(circle at center, ${colors.secondary}, transparent 70%)` 
          }}
          animate={{
            x: [0, -50, 30, 0],
            y: [0, 30, -40, 0],
            scale: [1, 0.9, 1.1, 1]
          }}
          transition={{
            duration: 30,
            repeat: Infinity,
            repeatType: "reverse",
            ease: "easeInOut"
          }}
        />
        
        {/* Tertiary color blob */}
        <motion.div 
          className="absolute top-[30%] left-[50%] w-[70%] h-[70%] rounded-full opacity-20 blur-[80px]"
          style={{ 
            background: `radial-gradient(circle at center, ${colors.tertiary}, transparent 70%)` 
          }}
          animate={{
            x: [0, 40, -30, 0],
            y: [0, -20, 40, 0],
            scale: [1, 1.2, 0.8, 1]
          }}
          transition={{
            duration: 20,
            repeat: Infinity,
            repeatType: "reverse",
            ease: "easeInOut"
          }}
        />
        
        {/* Additional smaller blobs for more dynamic movement */}
        <motion.div 
          className="absolute top-[10%] right-[20%] w-[40%] h-[40%] rounded-full opacity-15 blur-[60px]"
          style={{ 
            background: `radial-gradient(circle at center, ${colors.primary}80, transparent 70%)` 
          }}
          animate={{
            x: [0, -30, 20, 0],
            y: [0, 30, -20, 0],
            scale: [1, 1.1, 0.9, 1]
          }}
          transition={{
            duration: 15,
            repeat: Infinity,
            repeatType: "reverse",
            ease: "easeInOut"
          }}
        />
        
        <motion.div 
          className="absolute bottom-[20%] left-[30%] w-[30%] h-[30%] rounded-full opacity-15 blur-[50px]"
          style={{ 
            background: `radial-gradient(circle at center, ${colors.secondary}80, transparent 70%)` 
          }}
          animate={{
            x: [0, 20, -15, 0],
            y: [0, -25, 15, 0],
            scale: [1, 0.9, 1.1, 1]
          }}
          transition={{
            duration: 18,
            repeat: Infinity,
            repeatType: "reverse",
            ease: "easeInOut"
          }}
        />
      </div>
      
      {/* <main className="container max-w-6xl mx-auto px-4 py-12 relative z-10"> */}
      <div className={`containermin-h-screen bg-gradient-to-br from-indigo-900/90 to-purple-900/90 text-white ${isTauri ? 'mt-8' : ''}`}>
        <header className=" backdrop-blur-md ">
          <div className="container mx-auto px-4 py-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <Link href="/" className="text-2xl font-bold text-white">BriefCast</Link>
            </div>
            <div className="flex items-center gap-4">
              <Link href="/" className="text-white/80 font-medium">Player</Link>
              <Link href="/library" className="text-white/80 hover:text-white">Library</Link>
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
        <main className="container max-w-6xl mx-auto px-4 pt-4 pb-12 relative z-10">
        {!isTauri &&
          <h1 className="text-4xl font-bold mb-12 text-center bg-gradient-to-r from-amber-500 to-amber-600 text-transparent bg-clip-text">
            BriefCast
          </h1>}
          
          <div 
            className="backdrop-blur-xl bg-gradient-to-br from-black/10 to-black/30 rounded-2xl p-8 mx-auto border border-white/20 shadow-lg"
            style={{
              boxShadow: `0 20px 50px rgba(0,0,0,0.3), 
                          0 -5px 20px rgba(${colors.primary.match(/\d+/g)?.[0] || 0}, 
                                          ${colors.primary.match(/\d+/g)?.[1] || 0}, 
                                          ${colors.primary.match(/\d+/g)?.[2] || 0}, 0.15)`,
              backdropFilter: "blur(20px)",
            }}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 relative ">
              {/* Player View */}
              {(mobileView === 'player' || window.innerWidth >= 768) && (
                <div ref={playerContainerRef} className="mb-10 md:mb-0 relative pb-16 md:pb-0">
                  <div className="flex-grow">
                    <div className="flex flex-col gap-6 mb-6">
                      {/* Cover image */}
                      <div className="relative group w-full max-w-md mx-auto aspect-square overflow-hidden rounded-xl shadow-xl">
                        <Image
                          src={currentPodcast.image_url}
                          alt={`${currentPodcast.subcategory} Cover`}
                          fill
                          unoptimized
                          className="object-cover transition-transform duration-500 group-hover:scale-105"
                          priority
                        />
                        
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                        <div className="absolute bottom-0 left-0 p-6 text-white">
                          <h2 className="text-2xl font-bold">{currentPodcast.title}</h2>
                          {currentPodcast.link?.startsWith('http') && (
                            <a 
                              href={currentPodcast.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center text-sm text-amber-400 hover:text-amber-300"
                            >
                              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                              View Original Article
                            </a>
                          )}
                          <p className="text-sm text-white/70">Published: {toDate(currentPodcast.published_at)} • {toMinutes(Number(currentPodcast.duration_seconds))}</p>
                        </div>
                      </div>
                    </div>
                    
                    {/* Audio Controls */}
                    <div className="space-y-6 p-4 rounded-xl">
                      {/* Show error message if there's an error */}
                      {audioError && (
                        <div className="text-red-500 text-sm text-center mb-2">
                          {audioError}
                        </div>
                      )}
                      
                      {/* Waveform Progress Bar - Now clickable */}
                      <div 
                        className="relative h-16 w-full mb-2 cursor-pointer" 
                        onClick={handleWaveformClick}
                        onMouseMove={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const position = (e.clientX - rect.left) / rect.width;
                          setHoverPosition(position);
                        }}
                        onMouseLeave={() => setHoverPosition(-1)}
                      >
                        {/* Base waveform with current progress and hover effect */}
                        <div className="absolute inset-0 flex items-center gap-[2px]">
                          {waveformData.map((height, index) => {
                            const position = index / waveformData.length;
                            const progressPosition = progressPercentage / 100;
                            
                            // Don't highlight any bars when time is 0
                            const isPlayed = currentTime > 0 && position <= progressPosition;
                            
                            // Determine if this bar should show the hover preview effect
                            const isInHoverPreview = 
                              hoverPosition >= 0 && 
                              ((position > progressPosition && position <= hoverPosition) || 
                              (position < progressPosition && position >= hoverPosition));
                            
                            // Only apply hover effect to the section between current progress and hover position
                            // AND only to the unplayed section (don't change already played bars)
                            const shouldShowHoverColor = isInHoverPreview && 
                              !isPlayed && // Don't change color if already played
                              ((hoverPosition > progressPosition && position > progressPosition) || 
                              (hoverPosition < progressPosition && position < progressPosition));
                            
                            return (
                              <div
                                key={index}
                                className="flex-1 rounded-full transition-all duration-200"
                                style={{
                                  height: `${height}%`,
                                  background: shouldShowHoverColor
                                    ? 'rgb(120, 120, 120)' // Medium gray for hover preview
                                    : isPlayed
                                      ? 'linear-gradient(to bottom, rgb(212, 175, 55), rgb(153, 101, 21))' // Darker, richer gold gradient
                                      : 'rgb(220, 220, 220)', // Very light gray for unplayed sections
                                  opacity: isPlayed ? '1' : '0.7' // Increased opacity for unplayed sections
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                      
                      {/* Time Indicators */}
                      <div className="flex justify-between text-sm text-gray-500 mb-6">
                        <span>{formatTime(currentTime)}</span>
                        <span>{formatTime(duration || 0)}</span>
                      </div>
                      
                      <div className="flex justify-center items-center gap-6">
                        
                        {/* Download button */}
                        <button 
                          className="text-gray-600 dark:text-gray-300 hover:text-amber-500 dark:hover:text-amber-400 transition-colors"
                          onClick={async () => {
                            if (currentPodcast) {
                              setIsDownloading(true);
                              try {
                                downloadPodcast();
                                const success = await savePodcastOffline(currentPodcast);
                                if (success) {
                                  setIsAvailableOffline(true);
                                  alert('Podcast saved for offline listening!');
                                } else {
                                  alert('Failed to save podcast offline. Please try again.');
                                }
                              } catch (error) {
                                console.error('Error saving offline:', error);
                                alert('Error saving podcast offline');
                              } finally {
                                setIsDownloading(false);
                              }
                            }
                          }}
                        >
                          <div className="relative">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              {isAvailableOffline ? (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              ) : isDownloading ? (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              ) : (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              )}
                          </svg>
                            {isAvailableOffline && (
                              <span className="absolute -top-2 -right-2 bg-green-500 rounded-full w-3 h-3"></span>
                            )}
                          </div>
                        </button>
                
                        
                        {/* Thumbs down button */}
                        <button 
                          className={`rounded-full p-2 transition-colors ${
                            isDisliked 
                              ? 'bg-red-100 text-red-600' 
                              : 'text-gray-600 hover:text-red-600'
                          }`}
                          onClick={async () => {
                            setIsDisliked(!isDisliked);
                            setIsLiked(false);
                            // Track dislike action
                            if (!isDisliked) {
                              setLiked(false);
                            }
                          }}
                          aria-label="Dislike"
                        >
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
                          </svg>
                        </button>

                        {/* Previous track button */}
                        <button 
                          className="text-gray-600 dark:text-gray-300 hover:text-amber-500 dark:hover:text-amber-400 transition-colors"
                          onClick={() => playPrevious(true)}
                        >
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                          </svg>
                        </button>
                        
                        
                        <button 
                          className={`bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white p-4 rounded-full shadow-lg transition-all hover:shadow-xl hover:scale-105 ${
                            isAudioLoading ? 'opacity-75 cursor-wait' : ''
                          }`}
                          onClick={handlePlayRequest}
                          disabled={isAudioLoading}
                        >
                          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            {isAudioLoading ? (
                              // Loading spinner animation
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" className="animate-spin" />
                            ) : isPlaying ? (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            ) : (
                              <>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </>
                            )}
                          </svg>
                        </button>

                        {/* Next track button */}
                        <button 
                            className="text-gray-600 dark:text-gray-300 hover:text-amber-500 dark:hover:text-amber-400 transition-colors"
                            onClick={() => playNext(true)}
                          >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                            </svg>
                          </button>
                        
                        {/* Thumbs up button */}
                        <button 
                          className={`rounded-full p-2 transition-colors ${
                            isLiked === true 
                              ? 'bg-green-100 text-green-600' 
                              : 'text-gray-600 hover:text-green-600'
                          }`}
                          onClick={async () => {
                            setIsLiked(!isLiked);
                            setIsDisliked(false);
                            // Track like action
                            if (!isLiked) {
                              setLiked(true);
                            }
                          }}
                          aria-label="Like"
                        >
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                          </svg>
                        </button>
                        
                        
                        
                        {/* Playlist button */}
                        <button 
                          className="rounded-full p-2 text-gray-600 dark:text-gray-300 hover:text-amber-500 dark:hover:text-amber-400 transition-colors"
                          onClick={() => {
                            setShowPlaylistModal(true);
                          }}
                          aria-label="Add to playlist"
                          >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2h-2.5" />
                            </svg>
                          </button>
                      
                      </div>
                    </div>
                  </div>
                  
                  {/* Mobile navigation */}
                  <MobileNavigation />
                </div>
              )}

              {/* Transcript View - with fixed height matching player */}
              {mobileView === 'transcript' && window.innerWidth < 768 && (
                <div className="mb-10 md:mb-0 relative pb-16">
                  <div>
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-xl font-bold text-white">Transcript</h2>
                      <div className="flex items-center gap-2">
                        <div className="text-white/70 text-sm">{formatTime(currentTime)} / {formatTime(duration || 0)}</div>
                        <button 
                          className="p-2 rounded-full bg-amber-500 text-white"
                          onClick={handlePlayRequest}
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            {isAudioLoading ? (
                              // Loading spinner animation
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" className="animate-spin" />
                            ) : isPlaying ? (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            ) : (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            )}
                          </svg>
                        </button>
                      </div>
                    </div>
                    
                    <div className="overflow-y-auto" ref={mobileTranscriptRef} style={{ height: playerHeight ? `${playerHeight - 80}px` : '500px' }}>
                      <div className="space-y-4">
                        {transcriptData.map((item, i) => (
                          <p 
                            key={i} 
                            className={`cursor-pointer transition-all hover:bg-white/20 p-3 rounded-lg group relative ${
                              // More precise handling for the first item
                              (i === 0 && currentTime >= (item.time || 0) && currentTime < (transcriptData[1] ? (transcriptData[1].time || transcriptData[1].start) : Infinity)) ||
                              // Normal case for other items
                              (i > 0 && currentTime >= (item.time || item.start) && 
                              currentTime < (transcriptData[i+1] ? (transcriptData[i+1].time || transcriptData[i+1].start) : Infinity))
                                ? 'transform scale-[1.02] bg-white/10' 
                                : ''
                            }`}
                            onClick={() => seekToTranscriptTime(item.time || item.start)}
                          >
                            {/* Timestamp that appears on hover */}
                            <span className="absolute left-0 top-0 bg-amber-500 text-white text-xs px-2 py-1 rounded-tl-md opacity-0 group-hover:opacity-100 transition-opacity">
                              {formatTime(item.time || item.start)}
                            </span>
                            
                            <span className={`transition-colors ${
                              // More precise handling for the first item
                              (i === 0 && currentTime >= (item.time || 0) && currentTime < (transcriptData[1] ? (transcriptData[1].time || transcriptData[1].start) : Infinity)) ||
                              // Normal case for other items
                              (i > 0 && currentTime >= (item.time || item.start) && 
                              currentTime < (transcriptData[i+1] ? (transcriptData[i+1].time || transcriptData[i+1].start) : Infinity))
                                ? 'text-white font-medium text-lg'
                                : 'text-gray-300/70'  // Changed from text-gray-400 to text-gray-300/70
                            }`}>
                              {item.text}
                            </span>
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>
                  
                  {/* Mobile navigation */}
                  <MobileNavigation />
                </div>
              )}
              
              {/* Playlist View - with fixed height matching player */}
              {mobileView === 'playlist' && window.innerWidth < 768 && (
                <div className="mb-10 md:mb-0 relative pb-16">
                  <div>
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-xl font-bold text-white">Playlist</h2>
                      <div className="flex items-center gap-2">
                        <div className="text-white/70 text-sm">{formatTime(currentTime)} / {formatTime(duration || 0)}</div>
                        <button 
                          className="p-2 rounded-full bg-amber-500 text-white"
                          onClick={handlePlayRequest}
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            {isAudioLoading ? (
                              // Loading spinner animation
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" className="animate-spin" />
                            ) : isPlaying ? (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            ) : (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            )}
                          </svg>
                        </button>
                      </div>
                    </div>
                    
                    <div className="overflow-y-auto" style={{ height: playerHeight ? `${playerHeight - 80}px` : '500px' }}>
                      <Playlist />
                      {(!currentPlaylist || !playlists?.some(p => p.podcasts?.some(pod => pod.id === currentPodcast?.id))) && tmpPlaylist.length > 0 && (
                          <div className="mb-6">
                            <h3 className="text-lg font-semibold text-white mb-3 sticky top-0 py-2 z-10">Up Next</h3>
                            <div className="space-y-2">
                              {tmpPlaylist.map((podcast, index) => (
                                <div
                                  key={podcast.id}
                                  className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                                    currentPodcast?.id === podcast.id
                                      ? 'bg-white/20'
                                      : 'hover:bg-white/10'
                                  }`}
                                  onClick={() => {
                                    setAutoPlay(false);
                                    setCurrentPodcast(podcast);
                                  }}
                                >
                                  <div className="relative w-12 h-12 flex-shrink-0">
                                    <Image
                                      src={getCoverImageUrl(podcast.image_url)}
                                      alt={podcast.title}
                                      fill
                                      unoptimized
                                      className="object-cover rounded-md"
                                    />
                                  </div>
                                  <div className="flex-grow min-w-0">
                                    <h4 className="text-white font-medium truncate">{podcast.title}</h4>
                                    <p className="text-sm text-gray-400 truncate">{toDate(podcast.published_at)}</p>
                                  </div>
                                  <div className="flex-shrink-0">
                                    <button
                                      className="p-2 text-gray-400 hover:text-white"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setAddToPlaylist(podcast);
                                        setShowPlaylistModal(true);
                                      }}
                                    >
                                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                    </div>
                  </div>
                  
                  {/* Mobile navigation */}
                  <MobileNavigation />
                </div>
              )}

              {/* Right Column - Transcript and Playlist - Hidden on mobile */}
              <div className="hidden md:block">
                {/* Desktop tabs and content */}
                <div className="flex mb-6">
                  <button
                    className={`px-4 py-2 font-medium rounded-lg ${
                      activeTab === 'transcript' 
                        ? 'bg-white/10 text-white' 
                        : 'text-gray-300 hover:text-white'
                    }`}
                    onClick={() => setActiveTab('transcript')}
                  >
                    Transcript
                  </button>
                  <button
                    className={`px-4 py-2 font-medium rounded-lg ${
                      activeTab === 'playlist' 
                        ? 'bg-white/10 text-white' 
                        : 'text-gray-300 hover:text-white'
                    }`}
                    onClick={() => setActiveTab('playlist')}
                  >
                    Playlists
                  </button>
                </div>
                
                {/* Transcript Section */}
                {activeTab === 'transcript' && (
                  <div 
                    ref={transcriptRef}
                    className="h-full overflow-y-auto p-6 rounded-xl"
                    style={{ height: playerHeight ? `${playerHeight - 100}px` : '400px' }}
                  >
                    <div className="space-y-4">
                      {transcriptData.map((item, i) => (
                        <p 
                          key={i} 
                          className={`cursor-pointer transition-all hover:bg-white/20 p-3 rounded-lg group relative ${
                            // More precise handling for the first item
                            (i === 0 && currentTime >= (item.time || 0) && currentTime < (transcriptData[1] ? (transcriptData[1].time || transcriptData[1].start) : Infinity)) ||
                            // Normal case for other items
                            (i > 0 && currentTime >= (item.time || item.start) && 
                            currentTime < (transcriptData[i+1] ? (transcriptData[i+1].time || transcriptData[i+1].start) : Infinity))
                              ? 'transform scale-[1.02] bg-white/10' 
                              : ''
                          }`}
                          onClick={() => seekToTranscriptTime(item.time || item.start)}
                        >
                          {/* Timestamp that appears on hover */}
                          <span className="absolute left-0 top-0 bg-amber-500 text-white text-xs px-2 py-1 rounded-tl-md opacity-0 group-hover:opacity-100 transition-opacity">
                            {formatTime(item.time || item.start)}
                          </span>
                          
                          <span className={`transition-colors ${
                            // More precise handling for the first item
                            (i === 0 && currentTime >= (item.time || 0) && currentTime < (transcriptData[1] ? (transcriptData[1].time || transcriptData[1].start) : Infinity)) ||
                            // Normal case for other items
                            (i > 0 && currentTime >= (item.time || item.start) && 
                            currentTime < (transcriptData[i+1] ? (transcriptData[i+1].time || transcriptData[i+1].start) : Infinity))
                              ? 'text-white font-medium text-lg'
                              : 'text-gray-300/70'  // Changed from text-gray-400 to text-gray-300/70
                          }`}>
                            {item.text}
                          </span>
                        </p>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Playlist Section */}
                {activeTab === 'playlist' && (
                  <div className="h-[600px]">
                    <div className="h-full overflow-y-auto">
                      <div className="space-y-4">
                    <Playlist />
                        {/* Show temporary playlist if current podcast is not in any playlist */}
                        {(!currentPlaylist || !playlists?.some(p => p.podcasts?.some(pod => pod.id === currentPodcast?.id))) && tmpPlaylist.length > 0 && (
                          <div className="mb-6">
                            <h3 className="text-lg font-semibold text-white mb-3 sticky top-0 py-2 z-10">Up Next</h3>
                            <div className="space-y-2">
                              {tmpPlaylist.map((podcast, index) => (
                                <div
                                  key={podcast.id}
                                  className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                                    currentPodcast?.id === podcast.id
                                      ? 'bg-white/20'
                                      : 'hover:bg-white/10'
                                  }`}
                                  onClick={() => {
                                    setAutoPlay(false);
                                    setCurrentPodcast(podcast);
                                  }}
                                >
                                  <div className="relative w-12 h-12 flex-shrink-0">
                                    <Image
                                      src={getCoverImageUrl(podcast.image_url)}
                                      alt={podcast.title}
                                      fill
                                      unoptimized
                                      className="object-cover rounded-md"
                                    />
                                  </div>
                                  <div className="flex-grow min-w-0">
                                    <h4 className="text-white font-medium truncate">{podcast.title}</h4>
                                    <p className="text-sm text-gray-400 truncate">{toDate(podcast.published_at)}</p>
                                  </div>
                                  <div className="flex-shrink-0">
                                    <button
                                      className="p-2 text-gray-400 hover:text-white"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setAddToPlaylist(podcast);
                                        setShowPlaylistModal(true);
                                      }}
                                    >
                                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
      


      {/* Add Playlist Modal */}
      {showPlaylistModal && (addToPlaylistPodcast || currentPodcast) && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-indigo-900 border border-white/20 rounded-lg p-6 w-full max-w-md text-white">
            <h3 className="text-xl font-bold mb-4">Add to Playlist</h3>
            
            <div className="space-y-2 mb-4">
            {playlists?.map(playlist => (
              <button
                key={playlist.id}
                className="w-full text-left p-3 rounded-lg hover:bg-amber-600 flex justify-between items-center"
                onClick={async () => {
                  const podcast = addToPlaylistPodcast || currentPodcast;
                  await addToPlaylist(playlist.id, podcast);
                  logUserAction('add_to_playlist', { playlistId: playlist.id });
                  setShowPlaylistModal(false);
                  setAddToPlaylist(null);
                }}
              >
                <span>{playlist.name}</span>
                {playlist.id !== 'favorite' && playlist.id !== 'like' && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="text-gray-400 hover:text-red-500 p-1"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await deletePlaylist(playlist.id);
                      logUserAction('remove_from_playlist', { playlistId: playlist.id });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        deletePlaylist(playlist.id);
                        logUserAction('remove_from_playlist', { playlistId: playlist.id });
                      }
                    }}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </span>
                )}
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
                onClick={() => {
                  setShowPlaylistModal(false);
                }}
              >
                Cancel
              </button>
              
              <button
                className="bg-amber-500 text-white px-4 py-2 rounded-lg hover:bg-amber-600"
                onClick={async () => {
                  try {
                    const playlistName = newPlaylistName.trim() || `New Playlist ${(playlists || []).length + 1}`;
                    const newPlaylistId = await createPlaylist(playlistName);
                    await addToPlaylist(newPlaylistId, currentPodcast);
                    logUserAction('add_to_playlist', { playlistId: newPlaylistId });
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
    </div>
  );
}
