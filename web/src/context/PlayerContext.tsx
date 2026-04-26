"use client";
import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';

// Define user activity types
type UserAction = 'share' | 'download' | 'add_to_playlist' | 'like' | 'dislike' | 'remove_from_playlist' | 'seek';

type ActivityLog = {
  timestamp: number;
  action: UserAction;
  podcastId: string;
  details?: any;
};

type ListeningProgress = {
  podcastId: string;
  totalDuration: number;
  listenedSeconds: number[];
  lastPosition: number;
  positionLog: Array<{time: number, position: number}>;
  startTime: number;
};

type UserActivityState = {
  actions: ActivityLog[];
  listeningProgress: ListeningProgress | null;
};

type Podcast = {
  added_at: string;
  published_at: number;
  duration_seconds: number;
  image_url: string;
  favorite: boolean | undefined;
  transcript_url: string;
  positive: any;
  category: ReactNode;
  totalRating: any;
  subcategory: ReactNode;
  id: string;
  podcast_id?: string;
  title: string;
  show: string;
  episode: string;
  duration: string;
  audio_url: string;
  link?: string;
  rating?: number;
};

type Playlist = {
  id: string;
  name: string;
  podcasts: Podcast[];
};

type TransitionPodcast = {
  id: string;
  image_url: string;
  transcript_url: string;
  audio_url: string;
  duration_seconds?: number;
};

type PlayerContextType = {
  currentPodcast: Podcast | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playlists: Playlist[] | undefined;
  currentPlaylist: Playlist | null;
  tmpPlaylist: Podcast[];
  setCurrentPodcast: (podcast: Podcast) => void;
  togglePlayPause: () => void;
  seekTo: (time: number) => void;
  formatTime: (time: number) => string;
  addToPlaylist: (playlistId: string, podcast: Podcast) => void;
  deletePlaylist: (playlistId: string) => void;
  createPlaylist: (name: string) => Promise<string>;
  setCurrentPlaylist: (playlist: Playlist | null) => void;
  removeFromPlaylist: (playlistId: string, podcastId: string) => void;
  playNext: (skipTransition?: boolean) => void;
  playPrevious: (skipTransition?: boolean) => void;
  // New user activity tracking functions
  logUserAction: (action: UserAction, details?: any) => void;
  setLiked: (liked: boolean | null) => void;
  sharePodcast: () => void;
  downloadPodcast: () => void;
  setPodcastId: (podcastId: string) => void;
  setTmpPlaylist: (playlist: Podcast[]) => void;
  // Autoplay controls
  autoplayEnabled: boolean;
  autoplayBlocked: boolean;
  setAutoplayEnabled: (enabled: boolean) => void;
  enableAutoplay: () => void;
  setAutoPlay: (autoPlay: boolean) => void;
};

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  // Get the initial podcast ID from URL if available
  const [podcastId, setPodcastId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('podcast') || null;
    }
    return null;
  });
  const [currentPodcast, setCurrentPodcast] = useState<Podcast | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playlists, setPlaylists] = useState<Playlist[]>();
  const [currentPlaylist, setCurrentPlaylist] = useState<Playlist | null>(null);
  const [tmpPlaylist, setTmpPlaylist] = useState<Podcast[]>([]);
  const [isPlayingTransition, setIsPlayingTransition] = useState(false);
  const [nextPodcastId, setNextPodcastId] = useState<string | null>(null);
  const [userHasInteracted, setUserHasInteracted] = useState(false);
  const [autoplayEnabled, setAutoplayEnabled] = useState(true);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const transitionCacheRef = useRef<Record<string, TransitionPodcast>>({});
  const transitionPrefetchRef = useRef<Record<string, boolean>>({});
  const transitionInFlightRef = useRef<Record<string, Promise<TransitionPodcast | null>>>({});
  const router = useRouter();
  const pathname = usePathname();
  // Track if the next podcast change is from automatic transition
  const [isAutomaticTransition, setIsAutomaticTransition] = useState(false);
  // User activity tracking state
  const [userActivity, setUserActivity] = useState<UserActivityState>({
    actions: [],
    listeningProgress: null,
  });

  // Keep track of the last podcast whose activity we have already reported so we
  // do not accidentally POST the same podcast multiple times (e.g. once when a
  // transition clip starts and again afterwards).
  const lastReportedPodcastId = useRef<string | null>(null);
  // Retry counter for audio loading errors
  const audioErrorCountRef = useRef<number>(0);
  
  // Track if first render to avoid reporting on initial mount
  const isInitialMount = useRef(true);
  
  // Function to detect autoplay capability
  const detectAutoplaySupport = async () => {
    try {
      const audio = new Audio();
      audio.muted = true;
      audio.src = 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuDy/DHdi0FJ3zK8N2QQAoUX7Pp7alZFAw+m+DyvmMcBjt+zfDaey0HKoHO8t2JOQk=';
      
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        await playPromise;
        audio.pause();
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  };
  
  // Function to enable autoplay after user interaction
  const enableAutoplay = async () => {
    setUserHasInteracted(true);
    setAutoplayBlocked(false);
    
    // Test if autoplay is now available
    const isSupported = await detectAutoplaySupport();
    if (isSupported) {
      setAutoplayEnabled(true);
    }
  };
  
  // Helper function to attempt autoplay with fallback
  const attemptAutoplay = async (audio: HTMLAudioElement): Promise<boolean> => {
    if (!autoplayEnabled) return false;
    
    try {
      await audio.play();
      setIsPlaying(true);
      setAutoplayBlocked(false);
      return true;
    } catch (error) {
      setAutoplayBlocked(true);
      setIsPlaying(false);
      return false;
    }
  };
  
  // Helper function to safely parse JSON responses
  const safeJsonParse = async (response: Response) => {
    try {
      const text = await response.text();
      if (!text) {
        throw new Error('Empty response');
      }
      return JSON.parse(text);
    } catch (error) {
      console.error('Failed to parse JSON response:', error);
      console.error('Response status:', response.status);
      console.error('Response statusText:', response.statusText);
      throw new Error(`Invalid JSON response: ${error}`);
    }
  };
  
  // Helper function to log user actions
  const logUserAction = (action: UserAction, details?: any) => {
    if (!currentPodcast) return;
    
    setUserActivity(prev => ({
      ...prev,
      actions: [
        ...prev.actions,
        {
          timestamp: Date.now(),
          action,
          podcastId: currentPodcast.id,
          details
        }
      ]
    }));
  };
  
  // Convenience functions for common actions
  const setLiked = (liked: boolean | null) => {
    if (liked === true) {
      logUserAction('like');
    } else if (liked === false) {
      logUserAction('dislike');
    }
  };
  
  const sharePodcast = () => {
    logUserAction('share');
  };
  
  const downloadPodcast = () => {
    logUserAction('download');
  };
  
  // Function to report activity to backend
  const reportUserActivity = async () => {
    if (!userActivity.listeningProgress || !currentPodcast) return;
    
    // Skip if we have already reported this podcast earlier in the session.
    if (lastReportedPodcastId.current === userActivity.listeningProgress.podcastId) {
      return;
    }
    
    try {
      // Calculate total listened time and coverage
      const uniqueSeconds = new Set(userActivity.listeningProgress.listenedSeconds);
      const listenedDuration = uniqueSeconds.size;
      const totalDuration = userActivity.listeningProgress.totalDuration;
      const coverage = totalDuration > 0 ? (listenedDuration / totalDuration) * 100 : 0;
      
      // Prepare data for backend
      const activityData = {
        podcast_id: userActivity.listeningProgress.podcastId,
        actions: userActivity.actions,
        listened_seconds: Array.from(uniqueSeconds),
        listen_duration_seconds: listenedDuration,
        total_duration_seconds: totalDuration,
        coverage_percentage: coverage,
        last_position: userActivity.listeningProgress.lastPosition,
        position_log: userActivity.listeningProgress.positionLog,
        listening_time: Date.now() - userActivity.listeningProgress.startTime,
        auto_play: autoPlay,
      };

      if (activityData.podcast_id === "") {
        return;
      }
      
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}history/track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recommendationId: activityData.podcast_id,
          progressSeconds: activityData.last_position,
          durationSeconds: activityData.total_duration_seconds,
        }),
        cache: 'no-cache',
      });
      
      if (!response.ok) {
        console.error('Failed to report user activity:', await response.text());
      }

      // Mark this podcast as already reported so that subsequent state changes
      // (for example when the transition clip ends) do not trigger another POST.
      lastReportedPodcastId.current = activityData.podcast_id;
    } catch (error) {
      console.error('Error reporting user activity:', error);
    }
    
    // Reset activity tracking for the next podcast
    setUserActivity({
      actions: [],
      listeningProgress: null,
    });
  };
  
  // Track listened seconds
  useEffect(() => {
    if (!currentPodcast || currentTime <= 0) return;
    
    const second = Math.floor(currentTime);
    
    setUserActivity(prev => {
      // If this is a new podcast, initialize listening progress
      if (!prev.listeningProgress || prev.listeningProgress.podcastId !== currentPodcast.id) {
        return {
          ...prev,
          listeningProgress: {
            podcastId: currentPodcast.id,
            totalDuration: duration,
            listenedSeconds: isPlaying ? [second] : [],
            lastPosition: second,
            positionLog: [{ time: Date.now(), position: second }],
            startTime: Date.now(),
          }
        };
      }
      
      // Otherwise, update the existing listening progress
      return {
        ...prev,
        listeningProgress: {
          ...prev.listeningProgress,
          listenedSeconds: isPlaying 
            ? [...prev.listeningProgress.listenedSeconds, second]
            : prev.listeningProgress.listenedSeconds,
          lastPosition: second,
          totalDuration: duration,
        }
      };
    });
  }, [currentTime, currentPodcast, duration]);

  // Add this function to log position to backend
  const logPositionToBackend = async (position: number) => {
    if (!currentPodcast) return;
    
    try {
      if (currentPodcast.id === "") {
        return;
      }

      // if (currentPodcast.audio_url === ""){
      //   await new Promise(resolve => setTimeout(resolve, 1000));
      //   return logPositionToBackend(position);
      // }

      // desktop-ts has no real-time position endpoint — no-op
    } catch (error) {
      console.error('Error logging position:', error);
    }
  };

  // Modify the useEffect for position logging
  useEffect(() => {
    if (!currentPodcast) return;
    
    const intervalId = setInterval(() => {
      if (isPlaying && audioRef.current) {  // Only log when playing and audio exists
        logPositionToBackend(audioRef.current.currentTime); // Use audioRef.currentTime instead of state
      }
    }, 5000); // Log every 5 seconds
    
    return () => clearInterval(intervalId);
  }, [currentPodcast?.id, isPlaying]); // Remove currentTime from dependencies

  // Report activity when podcast changes, component unmounts or window is closed
  useEffect(() => {
    // Skip initial mount
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    
    // Report activity when podcast changes
    reportUserActivity();
    
    // Also report on unmount
    return () => {
      reportUserActivity();
    };
  }, [currentPodcast?.id]);
  
  // Report activity when window closes or user navigates away
  useEffect(() => {
    const handleBeforeUnload = () => {
      reportUserActivity();
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);
  
  useEffect(() => {
    function getLocation(): Promise<GeolocationPosition> {
      return new Promise((resolve, reject) => {
        // Check if geolocation is supported
        if (!navigator.geolocation) {
          reject(new Error('Geolocation is not supported by this browser'));
          return;
        }

        // Simple geolocation request with options
        navigator.geolocation.getCurrentPosition(
          resolve, 
          reject,
          {
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: 300000 // 5 minutes cache
          }
        );
      });
    }

    const loadPodcast = async () => {
      if (pathname.includes("/signin") || pathname.includes("/signup") || pathname.includes("/dashboard") || pathname.includes("/library") || pathname.includes("/history") || pathname.includes("/downloads")) {
        return;
      }
      // Skip loading if we already have the current podcast
      if (currentPodcast &&
        currentPodcast.id === podcastId &&
        currentPodcast.hasOwnProperty("image_url") &&
        currentPodcast.hasOwnProperty("audio_url") &&
        currentPodcast.hasOwnProperty("transcript_url") &&
        currentPodcast.image_url !== "" &&
        currentPodcast.audio_url !== "" &&
        currentPodcast.transcript_url !== "") {
        return;
      }
      let response;
      let data;
      if (podcastId && podcastId !== "") {
        try {
          response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "podcast/" + podcastId, {
            method: "GET",
            cache: 'no-cache',
            headers: {
              'Content-Type': 'application/json',
            }
          });
          if (response.status === 404) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            return loadPodcast();
          }
        } catch (error) {
          console.error("Error loading podcast:", error);
        }
      } else {
        // No podcastId — fetch today's pre-generated daily podcast (read-only, no generation)
        try {
          response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "podcast/daily", {
            method: "GET",
            cache: 'no-cache',
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          console.error("Error fetching daily podcast:", error);
          return; // network error — don't retry loop
        }
      }

        if (!response) return;

        // 204 / 404 → no daily podcast yet, wait for user to generate one
        if (response.status === 204 || response.status === 404) return;

        try {
          data = await safeJsonParse(response);
        } catch (error) {
          console.error("Error parsing podcast data:", error);
          return; // bad JSON — don't retry loop
        }

        // null means no podcast ready yet
        if (!data) return;

        if (!data.image_url || data.image_url === "") {
          data.image_url = `https://picsum.photos/seed/${data.id}/300/300`;
        } else if (!data.image_url.startsWith("http") && !data.image_url.startsWith('/api/') && !data.image_url.startsWith('blob:') && !data.image_url.startsWith('file://') && !data.image_url.startsWith('data:')) {
          data.image_url = `https://picsum.photos/seed/${data.id}/300/300`;
        }

        if (!data.transcript_url || data.transcript_url === "") return; // audio not ready
        if (!data.audio_url || data.audio_url === "") return;

        setCurrentPodcast(data);
        // Set autoPlay based on whether this is an automatic transition
        if (isAutomaticTransition) {
          setAutoPlay(true);
          setIsAutomaticTransition(false); // Reset the flag
        } else {
          setAutoPlay(false);
        }
    };
    loadPodcast();

  }, [podcastId]); // Only depend on podcastId changes

  const checkPlaylistAndFetchRecommendations = async (podcast: Podcast) => {
    try {
      if (podcast.id === undefined || podcast.id === "") return;
      if (podcast.audio_url === ""){
        await new Promise(resolve => setTimeout(resolve, 3000));
        return checkPlaylistAndFetchRecommendations(podcast);
      }
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}library/recommendations`, {
        method: "GET",
        cache: 'no-cache',
      }); 
      
      if (!response.ok) {
        // console.error("Failed to fetch recommendations:", response.status, response.statusText);
        return;
      }
      
      const recommendations = await safeJsonParse(response);
      const deduplicatedRecommendations = deduplicatePodcasts(tmpPlaylist, recommendations);
      setTmpPlaylist(deduplicatedRecommendations);
    } catch (error) {
      // console.error("Error fetching recommendations:", error);
    }
  };

  const deduplicatePodcasts = (list1: Podcast[], list2: Podcast[]): Podcast[] => {
    // Build a set of existing IDs for O(1) look-ups
    const existingIds = new Set(list1.map(p => p.id));
    const combined = [...list1];

    list2.forEach(p => {
      if (!existingIds.has(p.id)) {
        combined.push(p);
      }
    });

    return combined;
  };

  const isAbsoluteUrl = (value: string): boolean =>
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('file://') ||
    value.startsWith('blob:') ||
    value.startsWith('data:');

  const toAbsoluteBackendUrl = (rawUrl: string): string => {
    if (!rawUrl) return rawUrl;
    if (isAbsoluteUrl(rawUrl)) return rawUrl;
    const base = process.env.NEXT_PUBLIC_BACKEND_URL || '';
    if (!base) return rawUrl;
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    const normalizedPath = rawUrl.startsWith('/') ? rawUrl.slice(1) : rawUrl;
    return `${normalizedBase}${normalizedPath}`;
  };

  const getNextPodcastIdFromState = (podcast: Podcast | null): string | null => {
    if (!podcast) return null;

    if (currentPlaylist) {
      const currentIndex = currentPlaylist.podcasts.findIndex(p => p.id === podcast.id);
      if (currentIndex >= 0 && currentIndex < currentPlaylist.podcasts.length - 1) {
        return currentPlaylist.podcasts[currentIndex + 1].id;
      }
    }

    if (tmpPlaylist.length > 0) {
      const currentIndex = tmpPlaylist.findIndex(p => p.id === podcast.id);
      if (currentIndex === -1) return tmpPlaylist[0].id;
      if (currentIndex < tmpPlaylist.length - 1) return tmpPlaylist[currentIndex + 1].id;
    }

    return null;
  };

  const ensureTransition = async (currentId: string, nextId: string): Promise<TransitionPodcast | null> => {
    const key = `${currentId}:${nextId}`;
    if (transitionCacheRef.current[key]) {
      return transitionCacheRef.current[key];
    }
    if (transitionInFlightRef.current[key]) {
      return transitionInFlightRef.current[key];
    }

    const request = (async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id1: currentId, id2: nextId }),
          cache: 'no-cache'
        });
        if (!response.ok) return null;
        const data = await safeJsonParse(response);
        if (!data || !data.audio_url) return null;

        const normalized: TransitionPodcast = {
          id: data.id || `transition-${currentId}-${nextId}`,
          image_url: toAbsoluteBackendUrl(String(data.image_url || '')),
          transcript_url: toAbsoluteBackendUrl(String(data.transcript_url || '')),
          audio_url: toAbsoluteBackendUrl(String(data.audio_url || '')),
          duration_seconds: Number(data.duration_seconds || data.secs || 0) || undefined
        };
        transitionCacheRef.current[key] = normalized;
        return normalized;
      } catch {
        return null;
      } finally {
        delete transitionInFlightRef.current[key];
      }
    })();

    transitionInFlightRef.current[key] = request;
    return request;
  };

  // Initialize audio element
  useEffect(() => {
    audioRef.current = new Audio();
    
    const audio = audioRef.current;
    
    const updateTime = () => setCurrentTime(audio.currentTime);
    const updateDuration = () => {
      if (audio.duration && !isNaN(audio.duration)) {
        setDuration(audio.duration);
        // Successful load means we can reset the audio error counter
        audioErrorCountRef.current = 0;
      }
    };
    const handleEnded = () => setIsPlaying(false);
    const handleError = (e: any) => {
      // Increment error counter and attempt a limited number of retries
      audioErrorCountRef.current += 1;

      // After 3 failed attempts give up to avoid an infinite loop
      if (audioErrorCountRef.current <= 3 && audioRef.current) {
        const audioEl = audioRef.current;
        // Force a fresh load of the same source. This implicitly re-requests the
        // asset (no-cache headers are already set globally for the API).
        audioEl.load();

        // Try to resume playback automatically if we were previously playing
        const tryPlay = async () => {
          try {
            await audioEl.play();
            setIsPlaying(true);
            // Successful reload – reset the error counter
            audioErrorCountRef.current = 0;
          } catch {
            // Ignore – will retry again on the next error event until limit
            setIsPlaying(false);
          }
        };

        // Wait until metadata is available before trying to play
        if (audioEl.readyState < 1) {
          audioEl.addEventListener('loadedmetadata', tryPlay, { once: true });
        } else {
          tryPlay();
        }
      } else {
        // Exceeded retry attempts – stop playback
        setDuration(0);
        setIsPlaying(false);
      }
    };
    
    audio.addEventListener('timeupdate', updateTime);
    audio.addEventListener('loadedmetadata', updateDuration);
    audio.addEventListener('durationchange', updateDuration);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);
    
    // Check autoplay capability on mount
    detectAutoplaySupport().then(isSupported => {
      setAutoplayEnabled(false);
      // setAutoplayEnabled(isSupported);
      // if (!isSupported) {
      //   setAutoplayBlocked(true);
      // }
    });
    
    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', updateTime);
      audio.removeEventListener('loadedmetadata', updateDuration);
      audio.removeEventListener('durationchange', updateDuration);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, []);

  useEffect(() => {
    if (pathname.includes("/signin") || pathname.includes("/signup") || pathname.includes("/dashboard")) {
      return;
    }
    const loadPodcast = async () => {
      try {
        const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "playlists", {
          method: "GET",
          cache: 'no-cache',
        });

        if (!response.ok) {
          return;
        }

        const data = await safeJsonParse(response);
        // desktop-ts returns PlaylistInfo[] with `items` instead of `podcasts`
        const mapped = data.map((p: any) => ({ ...p, podcasts: p.items ?? [] }));
        setPlaylists(mapped);
      } catch (error) {
        console.error("Error loading playlists:", error);
      }
    }
    loadPodcast();
  }, [])

  // Update audio source when podcast changes
  useEffect(() => {
    if (!audioRef.current || !currentPodcast) return;
    
    const loadAudioSource = async () => {
      try {
        // Check if we have offline storage functions from page.tsx
        if (window.isPodcastAvailableOffline && window.loadAsset) {
          try {
            // Check if this podcast is available offline
            const isAvailable = await window.isPodcastAvailableOffline(currentPodcast.id);
            
            if (isAvailable && audioRef.current) {
              // Load audio from offline storage
              const audioUrl = await window.loadAsset(currentPodcast.audio_url, 'audio');
              if (audioUrl && audioRef.current) {
                audioRef.current.src = audioUrl;
                await audioRef.current.load();
                
                // Attempt autoplay for transitions or if user has interacted
                if (isPlayingTransition || userHasInteracted) {
                  await attemptAutoplay(audioRef.current);
                } else {
                  // Try autoplay on first load
                  const autoplaySucceeded = await attemptAutoplay(audioRef.current);
                  if (!autoplaySucceeded) {
                    setIsPlaying(false);
                  }
                }
                return;
              }
            }
          } catch (error) {
            console.error("Error accessing offline content:", error);
          }
        }
        
        // Fallback to network URL
        if (audioRef.current) {
          audioRef.current.src = currentPodcast.audio_url;
          await audioRef.current.load();
          
          // Attempt autoplay for transitions or if user has interacted
          if (isPlayingTransition || userHasInteracted) {
            await attemptAutoplay(audioRef.current);
          } else {
            // Try autoplay on first load
            const autoplaySucceeded = await attemptAutoplay(audioRef.current);
            if (!autoplaySucceeded) {
              setIsPlaying(false);
            }
          }
        }
      } catch (error) {
        console.error("Error loading audio source:", error);
        setIsPlaying(false);
      }
    };
    
    loadAudioSource();
  }, [currentPodcast, userHasInteracted, isPlayingTransition]);

  // Format time in MM:SS
  const formatTime = (timeInSeconds: number) => {
    const minutes = Math.floor(timeInSeconds / 60) || 0;
    const seconds = Math.floor(timeInSeconds % 60) || 0;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  // Modify the togglePlayPause function to handle loading states
  const togglePlayPause = async () => {
    if (!audioRef.current || !currentPodcast) return;
    
    // Mark that user has interacted with the player and enable autoplay
    if (!userHasInteracted) {
      await enableAutoplay();
    }
    
    try {
      if (isPlaying) {
        audioRef.current.pause();
        // Log position when pausing
        logPositionToBackend(currentTime);
        setIsPlaying(false);
        /* Prevent any subsequent attemptAutoplay from immediately
           restarting playback unless the user explicitly presses play. */
        setAutoplayEnabled(false);
      } else {
        // If audio is not loaded yet, wait for it
        if (audioRef.current.readyState < 2) {
          await new Promise((resolve) => {
            audioRef.current?.addEventListener('canplay', resolve, { once: true });
          });
        }
        await audioRef.current.play();
        // Log position when starting to play
        logPositionToBackend(currentTime);
        setIsPlaying(true);
        // Re-enable autoplay because the user just interacted to play.
        setAutoplayEnabled(true);
      }
    } catch (err) {
      setIsPlaying(false);
    }
  };

  // Seek to specific time
  const seekTo = (time: number) => {
    if (!audioRef.current) return;
    
    // Log the seek action
    if (currentPodcast) {
      logUserAction('seek', { from: currentTime, to: time });
      
      // Also update the listening progress with this seek action
      setUserActivity(prev => {
        if (!prev.listeningProgress) return prev;
        
        return {
          ...prev,
          listeningProgress: {
            ...prev.listeningProgress,
            lastPosition: time,
            positionLog: [
              ...prev.listeningProgress.positionLog, 
              { time: Date.now(), position: time }
            ]
          }
        };
      });
    }
    
    audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  // Create a new playlist
  const createPlaylist = async (name: string): Promise<string> => {
    try {
      const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "playlists", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
        cache: 'no-cache',
      });

      if (!response.ok) {
        throw new Error(`Failed to create playlist: ${response.status} ${response.statusText}`);
      }

      const data = await safeJsonParse(response);
      if (data.hasOwnProperty('id') && data.id !== null) {
        const newPlaylist: Playlist = {
          id: data.id,
          name,
          podcasts: data.items ?? []
        };
        setPlaylists(prev => prev ? [...prev, newPlaylist] : [newPlaylist]);
        return newPlaylist.id;
      }
      
      throw new Error("Invalid response format from server");
    } catch (error) {
      console.error("Error creating playlist:", error);
      throw new Error("Failed to create playlist");
    }
  };

  const deletePlaylist = async (playlistId: string) => {
    const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "playlists/" + playlistId, {
      method: "DELETE",
      cache: 'no-cache',
    });
    if (response.ok) {
      setPlaylists(prev => prev?.filter(playlist => playlist.id !== playlistId));
      return;
    }
    throw new Error("Failed to delete playlist");
  };

  const addToPlaylist = async (playlistId: string, podcast: Podcast) => {
    // Log the action
    logUserAction('add_to_playlist', { playlistId });
    
    const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "playlists/" + playlistId + "/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ podcastId: podcast.id }),
      cache: 'no-cache',
    });
    if (response.ok) {
      if (playlistId === currentPlaylist?.id) {
        if (currentPlaylist && currentPlaylist.podcasts && !currentPlaylist.podcasts.some(p => p.id === podcast.id)) {
          setCurrentPlaylist(prev => {
            if (!prev) return null;
            return {
              id: prev.id,
              name: prev.name,
              podcasts: [...(prev.podcasts || []), podcast]
            };
          });
        }
      }
      setPlaylists(prev => 
        prev?.map(playlist => {
          if (playlist.id === playlistId) {
            const exists = playlist.podcasts?.some(p => p.id === podcast.id);
            if (!exists) {
              return {
                ...playlist,
                podcasts: [...(playlist.podcasts || []), podcast]
              };
            }
          }
          return playlist;
        })
      );
    }
  };

  const removeFromPlaylist = async (playlistId: string, podcastId: string) => {
    // Log the action
    logUserAction('remove_from_playlist', { playlistId });
    
    const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "playlists/" + playlistId + "/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ podcastId }),
      cache: 'no-cache',
    });
    if (response.ok) {
      if (playlistId === currentPlaylist?.id) {
        setCurrentPlaylist(prev => {
          if (!prev) return null;
          return {
            id: prev.id,
            name: prev.name,
            podcasts: prev.podcasts?.filter(p => p.id !== podcastId && p.podcast_id !== podcastId)
          };
        });
      }
      
      setPlaylists(prev => 
        prev?.map(playlist => {
          if (playlist.id === playlistId) {
            return {
              ...playlist,
              podcasts: playlist.podcasts?.filter(p => 
                p.id !== podcastId && p.podcast_id !== podcastId
              )
            };
          }
          return playlist;
        })
      );
    }
  };


  useEffect(() => {
    const fetchPodcast = async () => {
      if (!currentPodcast) return;
      let list = tmpPlaylist;
      if (currentPlaylist && currentPlaylist.podcasts.findIndex(p => p.id === currentPodcast.id) >= 0) {
        list = currentPlaylist.podcasts;
      }
      if(list.length == 0 || list.findIndex(p => p.id === currentPodcast.id) === -1 || list.findIndex(p => p.id === currentPodcast.id) >= list.length - 1){
        await checkPlaylistAndFetchRecommendations(currentPodcast); 
        list = tmpPlaylist;
      }
      if (list.length > 0 && currentPodcast && list.findIndex(p => p.id === currentPodcast.id) < list.length - 1) {
        const podcastId = list[list.findIndex(p => p.id === currentPodcast.id) + 1].id;
        // prefetch next podcast metadata
        fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "podcast/" + podcastId, {
          method: "GET",
          cache: 'no-cache',
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    fetchPodcast();
  }, [currentPodcast])

  useEffect(() => {
    if (!currentPodcast || isPlayingTransition || !duration || duration <= 0) return;

    const nextId = getNextPodcastIdFromState(currentPodcast);
    if (!nextId) return;

    const remaining = duration - currentTime;
    if (remaining > 20) return;

    const key = `${currentPodcast.id}:${nextId}`;
    if (transitionPrefetchRef.current[key]) return;
    transitionPrefetchRef.current[key] = true;
    void ensureTransition(currentPodcast.id, nextId);
  }, [currentPodcast?.id, currentTime, duration, currentPlaylist, tmpPlaylist, isPlayingTransition]);

  // Play next podcast in playlist
  const playNext = (skipTransition: boolean = false) => {
    // Before moving away from the current podcast, flush activity data
    reportUserActivity();
    if (!currentPodcast) return;

    let nextPodcastId: string | null = null;

    if (currentPlaylist) {
      // If we have a current playlist, use its logic
      const currentIndex = currentPlaylist.podcasts.findIndex(p => p.id === currentPodcast.id);
      if (currentIndex === -1 || currentIndex === currentPlaylist.podcasts.length - 1) return;
      nextPodcastId = currentPlaylist.podcasts[currentIndex + 1].id;
    } else if (tmpPlaylist.length > 0) {
      // If we have a tmp playlist, play from it
      const currentIndex = tmpPlaylist.findIndex(p => p.id === currentPodcast.id);
      if (currentIndex === -1) {
        // If current podcast is not in tmp playlist, play the first one
        nextPodcastId = tmpPlaylist[0].id;
      } else if (currentIndex < tmpPlaylist.length - 1) {
        // Play the next one in tmp playlist
        nextPodcastId = tmpPlaylist[currentIndex + 1].id;
      } else if (tmpPlaylist.length === 0 || currentIndex >= tmpPlaylist.length - 1) {
        // Only call checkPlaylistAndFetchRecommendations if currentPodcast is not null
        if (currentPodcast) {
          checkPlaylistAndFetchRecommendations(currentPodcast);
        }
        return;
      }
    }

    if (nextPodcastId) {
      if (skipTransition) {
        // Jump directly to the next podcast (still automatic)
        setIsAutomaticTransition(true); // Mark as automatic transition
        setPodcastId(nextPodcastId);
      } else {
        // Load and play transition before playing next podcast
        loadAndPlayTransition(currentPodcast.id, nextPodcastId);
      }
    }
  };

  // Play previous podcast in playlist
  const playPrevious = (skipTransition: boolean = false) => {
    // Flush activity before changing podcast
    reportUserActivity();
    if (!currentPodcast) return;

    let previousPodcastId: string | null = null;

    if (currentPlaylist) {
      // If we have a current playlist, use its logic
      const currentIndex = currentPlaylist.podcasts.findIndex(p => p.id === currentPodcast.id);
      if (currentIndex <= 0) return;
      previousPodcastId = currentPlaylist.podcasts[currentIndex - 1].id;
    } else if (tmpPlaylist.length > 0) {
      // If we have a tmp playlist, play from it
      const currentIndex = tmpPlaylist.findIndex(p => p.id === currentPodcast.id);
      if (currentIndex > 0) {
        // Play the previous one in tmp playlist
        previousPodcastId = tmpPlaylist[currentIndex - 1].id;
      }
      // If currentIndex is 0 or -1, we can't go back further
    }

    if (previousPodcastId) {
      if (skipTransition) {
        // Jump directly to the previous podcast (still automatic)
        setIsAutomaticTransition(true); // Mark as automatic transition
        setPodcastId(previousPodcastId);
      } else {
        // For now, we don't have transitions for going backwards, so just set directly
        setIsAutomaticTransition(true); // Mark as automatic transition
        setPodcastId(previousPodcastId);
      }
    }
  };

  const loadAndPlayTransition = async (currentId: string, nextId: string) => {
    const transition = await ensureTransition(currentId, nextId);
    if (!transition?.audio_url || !audioRef.current) {
      setIsAutomaticTransition(true);
      setPodcastId(nextId);
      return;
    }

    try {
      setNextPodcastId(nextId);
      setIsPlayingTransition(true);
      audioRef.current.src = transition.audio_url;
      audioRef.current.load();
      await attemptAutoplay(audioRef.current);
    } catch {
      setIsPlayingTransition(false);
      setNextPodcastId(null);
      setIsAutomaticTransition(true);
      setPodcastId(nextId);
    }
  };

  // Modify the useEffect for audio ended to handle transitions
  useEffect(() => {
    if (!audioRef.current) return;

    const handleEnded = () => {
      setIsPlaying(false);
      
      if (isPlayingTransition && nextPodcastId) {
        // If we just finished playing a transition, play the next podcast
        setIsPlayingTransition(false);
        setIsAutomaticTransition(true); // Mark this as automatic transition
        setPodcastId(nextPodcastId);
        setNextPodcastId(null);
      } else {
        // Normal case - play next podcast
        playNext();
      }
    };

    audioRef.current.addEventListener('ended', handleEnded);
    return () => {
      if (audioRef.current) {
        audioRef.current.removeEventListener('ended', handleEnded);
      }
    };
  }, [currentPodcast, tmpPlaylist, currentPlaylist, isPlayingTransition, nextPodcastId]);

  // Custom setCurrentPodcast function that handles autoPlay state
  const handleSetCurrentPodcast = (podcast: Podcast) => {
    if (currentPodcast && currentPodcast.id !== podcast.id) {
      // Report activity of the podcast we are leaving
      reportUserActivity();
    }
    setCurrentPodcast(podcast);
  };

  return (
    <PlayerContext.Provider
      value={{
        currentPodcast,
        isPlaying,
        currentTime,
        duration,
        playlists,
        currentPlaylist,
        tmpPlaylist,
        setCurrentPodcast: handleSetCurrentPodcast,
        togglePlayPause,
        seekTo,
        formatTime,
        addToPlaylist,
        deletePlaylist,
        createPlaylist,
        setCurrentPlaylist,
        removeFromPlaylist,
        playNext,
        playPrevious,
        // New user activity tracking functions
        logUserAction,
        setLiked,
        sharePodcast,
        downloadPodcast,
        setPodcastId,
        setTmpPlaylist,
        // Autoplay controls
        autoplayEnabled,
        autoplayBlocked,
        setAutoplayEnabled,
        enableAutoplay,
        setAutoPlay
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const context = useContext(PlayerContext);
  if (context === undefined) {
    throw new Error('usePlayer must be used within a PlayerProvider');
  }
  return context;
} 