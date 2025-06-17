
interface Window {
    // Podcast offline storage functions
    isPodcastAvailableOffline?: (podcastId: string) => Promise<boolean>;
    loadAsset?: (url: string, type: string) => Promise<string | null>;
    savePodcastOffline?: (podcast: any) => Promise<boolean>;
    loadPodcastFromStorage?: (podcastId: string) => Promise<any | null>;
    deletePodcastFromStorage?: (podcastId: string) => Promise<boolean>;
    
    // Clerk auth related properties
    Clerk?: {
      session: {
        getToken: (options?: { skipCache?: boolean }) => Promise<string>;
      };
      addListener: (callback: (event: { type: string }) => void) => void;
    };
    
    // Service worker flags
    swActive?: boolean;
    
    // Debug helpers
    debugClerkToken?: () => Promise<boolean>;
  } 