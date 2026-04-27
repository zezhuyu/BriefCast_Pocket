import { contextBridge, ipcRenderer } from "electron";
import {
  AppSettings,
  DownloadPodcastItem,
  DownloadSaveInput,
  GenerateBriefingResult,
  GeneratedEpisode,
  HistoryTrackInput,
  ListenHistoryItem,
  MediaManifest,
  MediaResourceFormat,
  MediaResourcePayload,
  Podcast,
  PlaylistInfo,
  RecommendationPodcast,
  RendererBridge,
  SearchMode,
  SearchResult,
  SyncResult,
  Briefing,
  UserPreferenceSettings,
  UserProfile
} from "../shared/types";

const api: RendererBridge = {
  // Settings
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke("settings:get");
  },
  saveSettings(settings: AppSettings): Promise<AppSettings> {
    return ipcRenderer.invoke("settings:save", settings);
  },

  // News
  syncNews(): Promise<SyncResult> {
    return ipcRenderer.invoke("news:sync");
  },
  searchArticles(query: string, mode: SearchMode, limit?: number): Promise<SearchResult[]> {
    return ipcRenderer.invoke("news:search", query, mode, limit);
  },
  preferenceSearch(description: string, limit?: number): Promise<SearchResult[]> {
    return ipcRenderer.invoke("news:preference-search", description, limit);
  },
  getFinancialNews(limit?: number): Promise<SearchResult[]> {
    return ipcRenderer.invoke("news:financial", limit);
  },

  // Text briefing
  generateDailyBriefing(): Promise<GenerateBriefingResult> {
    return ipcRenderer.invoke("briefing:generate");
  },
  getBriefings(limit?: number): Promise<Briefing[]> {
    return ipcRenderer.invoke("briefing:list", limit);
  },

  // Library
  getRecommendations(limit?: number): Promise<RecommendationPodcast[]> {
    return ipcRenderer.invoke("library:recommendations", limit);
  },
  getTrending(limit?: number): Promise<RecommendationPodcast[]> {
    return ipcRenderer.invoke("library:trending", limit);
  },

  // History
  getHistory(limit?: number): Promise<ListenHistoryItem[]> {
    return ipcRenderer.invoke("history:list", limit);
  },
  trackHistory(input: HistoryTrackInput): Promise<ListenHistoryItem> {
    return ipcRenderer.invoke("history:track", input);
  },

  // Downloads
  getDownloads(limit?: number): Promise<DownloadPodcastItem[]> {
    return ipcRenderer.invoke("downloads:list", limit);
  },
  saveDownload(input: DownloadSaveInput): Promise<DownloadPodcastItem> {
    return ipcRenderer.invoke("downloads:save", input);
  },
  removeDownload(id: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke("downloads:remove", id);
  },

  // Media resources
  getMediaManifest(): Promise<MediaManifest> {
    return ipcRenderer.invoke("media:manifest");
  },
  readMediaResource(name: string, format: MediaResourceFormat = "base64"): Promise<MediaResourcePayload> {
    return ipcRenderer.invoke("media:read", name, format);
  },

  // Podcast audio generation
  generateEpisode(recommendationId: string): Promise<GeneratedEpisode> {
    return ipcRenderer.invoke("episode:generate", recommendationId);
  },
  getDailyPodcast(): Promise<Podcast | null> {
    return ipcRenderer.invoke("podcast:get-daily");
  },
  forceDailyPodcast(): Promise<Podcast | null> {
    return ipcRenderer.invoke("podcast:force-daily");
  },
  generatePodcastAudio(recommendationId: string): Promise<Podcast> {
    return ipcRenderer.invoke("podcast:generate-audio", recommendationId);
  },
  generateSummaryPodcast(podcastIds: string[]): Promise<Podcast> {
    return ipcRenderer.invoke("podcast:generate-summary", podcastIds);
  },
  getPodcastById(podcastId: string): Promise<Podcast | null> {
    return ipcRenderer.invoke("podcast:get", podcastId);
  },
  ratePodcast(podcastId: string, rating: number): Promise<void> {
    return ipcRenderer.invoke("podcast:rate", podcastId, rating);
  },

  // Playlists
  getPlaylists(): Promise<PlaylistInfo[]> {
    return ipcRenderer.invoke("playlist:list");
  },
  createPlaylist(name: string, description?: string): Promise<PlaylistInfo> {
    return ipcRenderer.invoke("playlist:create", name, description);
  },
  deletePlaylist(playlistId: string): Promise<void> {
    return ipcRenderer.invoke("playlist:delete", playlistId);
  },
  addToPlaylist(playlistId: string, podcastId: string): Promise<void> {
    return ipcRenderer.invoke("playlist:add", playlistId, podcastId);
  },
  removeFromPlaylist(playlistId: string, podcastId: string): Promise<void> {
    return ipcRenderer.invoke("playlist:remove", playlistId, podcastId);
  },

  // User profile
  getUserProfile(): Promise<UserProfile> {
    return ipcRenderer.invoke("user:get");
  },
  updateUserProfile(prefs: Partial<UserPreferenceSettings>): Promise<UserProfile> {
    return ipcRenderer.invoke("user:update", prefs);
  },

  // Settings hotload
  onSettingsChanged(cb: (settings: AppSettings) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, settings: AppSettings) => cb(settings);
    ipcRenderer.on("settings:changed", handler);
    return () => ipcRenderer.removeListener("settings:changed", handler);
  },
};

contextBridge.exposeInMainWorld("briefcast", api);
