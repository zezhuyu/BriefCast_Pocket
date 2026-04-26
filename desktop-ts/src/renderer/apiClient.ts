import {
  AppSettings,
  Briefing,
  DownloadPodcastItem,
  DownloadSaveInput,
  GenerateBriefingResult,
  GeneratedEpisode,
  HistoryTrackInput,
  ListenHistoryItem,
  MediaManifest,
  MediaResourceFormat,
  MediaResourcePayload,
  PlaylistInfo,
  Podcast,
  RecommendationPodcast,
  RendererBridge,
  SearchMode,
  SearchResult,
  SyncResult,
  UserPreferenceSettings,
  UserProfile
} from "../shared/types";

const LOCAL_API_BASE = "http://127.0.0.1:5002";

interface HealthResponse {
  ok?: boolean;
  service?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 1800, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchJson<T>(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

class HttpBridgeClient implements RendererBridge {
  async getSettings(): Promise<AppSettings> {
    return fetchJson<AppSettings>(`${LOCAL_API_BASE}/api/settings`);
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    return fetchJson<AppSettings>(`${LOCAL_API_BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    });
  }

  async syncNews(): Promise<SyncResult> {
    return fetchJson<SyncResult>(`${LOCAL_API_BASE}/api/news/sync`, {
      method: "POST"
    });
  }

  async searchArticles(query: string, mode: SearchMode, limit?: number): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      query,
      mode,
      limit: String(limit ?? 30)
    });

    return fetchJson<SearchResult[]>(`${LOCAL_API_BASE}/api/news/search?${params.toString()}`);
  }

  async preferenceSearch(description: string, limit?: number): Promise<SearchResult[]> {
    return fetchJson<SearchResult[]>(`${LOCAL_API_BASE}/api/news/preference-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, limit: limit ?? 20 })
    });
  }

  async generateDailyBriefing(): Promise<GenerateBriefingResult> {
    return fetchJson<GenerateBriefingResult>(`${LOCAL_API_BASE}/api/briefings/generate`, {
      method: "POST"
    });
  }

  async getBriefings(limit?: number): Promise<Briefing[]> {
    const params = new URLSearchParams({ limit: String(limit ?? 10) });
    return fetchJson<Briefing[]>(`${LOCAL_API_BASE}/api/briefings?${params.toString()}`);
  }

  async getRecommendations(limit?: number): Promise<RecommendationPodcast[]> {
    const params = new URLSearchParams({ limit: String(limit ?? 100) });
    return fetchJson<RecommendationPodcast[]>(`${LOCAL_API_BASE}/api/library/recommendations?${params.toString()}`);
  }

  async getHistory(limit?: number): Promise<ListenHistoryItem[]> {
    const params = new URLSearchParams({ limit: String(limit ?? 200) });
    return fetchJson<ListenHistoryItem[]>(`${LOCAL_API_BASE}/api/history?${params.toString()}`);
  }

  async trackHistory(input: HistoryTrackInput): Promise<ListenHistoryItem> {
    return fetchJson<ListenHistoryItem>(`${LOCAL_API_BASE}/api/history/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
  }

  async getDownloads(limit?: number): Promise<DownloadPodcastItem[]> {
    const params = new URLSearchParams({ limit: String(limit ?? 500) });
    return fetchJson<DownloadPodcastItem[]>(`${LOCAL_API_BASE}/api/downloads?${params.toString()}`);
  }

  async saveDownload(input: DownloadSaveInput): Promise<DownloadPodcastItem> {
    return fetchJson<DownloadPodcastItem>(`${LOCAL_API_BASE}/api/downloads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
  }

  async removeDownload(id: string): Promise<{ ok: boolean }> {
    const params = new URLSearchParams({ id });
    return fetchJson<{ ok: boolean }>(`${LOCAL_API_BASE}/api/downloads?${params.toString()}`, {
      method: "DELETE"
    });
  }

  async getMediaManifest(): Promise<MediaManifest> {
    return fetchJson<MediaManifest>(`${LOCAL_API_BASE}/api/media/manifest`);
  }

  async readMediaResource(name: string, format: MediaResourceFormat = "base64"): Promise<MediaResourcePayload> {
    const params = new URLSearchParams({ name, format });
    return fetchJson<MediaResourcePayload>(`${LOCAL_API_BASE}/api/media/resource?${params.toString()}`);
  }

  async generateEpisode(recommendationId: string): Promise<GeneratedEpisode> {
    return fetchJson<GeneratedEpisode>(`${LOCAL_API_BASE}/api/episode/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recommendationId })
    });
  }

  async getTrending(limit?: number): Promise<RecommendationPodcast[]> {
    const params = new URLSearchParams({ limit: String(limit ?? 20) });
    return fetchJson<RecommendationPodcast[]>(`${LOCAL_API_BASE}/api/library/trending?${params.toString()}`);
  }

  async getDailyPodcast(): Promise<Podcast | null> {
    return fetchJson<Podcast | null>(`${LOCAL_API_BASE}/api/podcast/daily`);
  }

  async forceDailyPodcast(): Promise<Podcast | null> {
    return fetchJson<Podcast | null>(`${LOCAL_API_BASE}/api/podcast/daily/force`, { method: "POST" });
  }

  async generatePodcastAudio(recommendationId: string): Promise<Podcast> {
    return fetchJson<Podcast>(`${LOCAL_API_BASE}/api/podcast/generate-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recommendationId })
    });
  }

  async generateSummaryPodcast(podcastIds: string[]): Promise<Podcast> {
    return fetchJson<Podcast>(`${LOCAL_API_BASE}/api/podcast/generate-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ podcastIds })
    });
  }

  async getPodcastById(podcastId: string): Promise<Podcast | null> {
    return fetchJson<Podcast | null>(`${LOCAL_API_BASE}/api/podcast/${podcastId}`);
  }

  async ratePodcast(podcastId: string, rating: number): Promise<void> {
    await fetchJson(`${LOCAL_API_BASE}/api/podcast/${podcastId}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating })
    });
  }

  async getPlaylists(): Promise<PlaylistInfo[]> {
    return fetchJson<PlaylistInfo[]>(`${LOCAL_API_BASE}/api/playlists`);
  }

  async createPlaylist(name: string, description?: string): Promise<PlaylistInfo> {
    return fetchJson<PlaylistInfo>(`${LOCAL_API_BASE}/api/playlists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description })
    });
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await fetchJson(`${LOCAL_API_BASE}/api/playlists/${playlistId}`, { method: "DELETE" });
  }

  async addToPlaylist(playlistId: string, podcastId: string): Promise<void> {
    await fetchJson(`${LOCAL_API_BASE}/api/playlists/${playlistId}/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ podcastId })
    });
  }

  async removeFromPlaylist(playlistId: string, podcastId: string): Promise<void> {
    await fetchJson(`${LOCAL_API_BASE}/api/playlists/${playlistId}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ podcastId })
    });
  }

  async getUserProfile(): Promise<UserProfile> {
    return fetchJson<UserProfile>(`${LOCAL_API_BASE}/api/user/profile`);
  }

  async updateUserProfile(prefs: Partial<UserPreferenceSettings>): Promise<UserProfile> {
    return fetchJson<UserProfile>(`${LOCAL_API_BASE}/api/user/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs)
    });
  }

  async getFinancialNews(limit?: number): Promise<SearchResult[]> {
    const params = new URLSearchParams({ limit: String(limit ?? 30) });
    return fetchJson<SearchResult[]>(`${LOCAL_API_BASE}/api/news/financial?${params.toString()}`);
  }
}

let resolvedClient: RendererBridge | null = null;
const httpClient = new HttpBridgeClient();

function getWindowBridge(): RendererBridge | null {
  if (typeof window === "undefined") {
    return null;
  }

  const bridge = (window as Window & { briefcast?: RendererBridge }).briefcast;
  return bridge ?? null;
}

async function detectHttpBridge(): Promise<RendererBridge | null> {
  try {
    const health = await fetchJsonWithTimeout<HealthResponse>(`${LOCAL_API_BASE}/health`, 1500);
    if (health?.ok && health.service === "briefcast-desktop-ts") {
      return httpClient;
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveClient(): Promise<RendererBridge> {
  const windowBridge = getWindowBridge();
  if (windowBridge) {
    resolvedClient = windowBridge;
    return resolvedClient;
  }

  if (resolvedClient && resolvedClient !== httpClient) {
    return resolvedClient;
  }

  if (resolvedClient === httpClient) {
    const stillAlive = await detectHttpBridge();
    if (stillAlive) {
      return resolvedClient;
    }
    resolvedClient = null;
  }

  const httpBridge = await detectHttpBridge();
  if (httpBridge) {
    resolvedClient = httpBridge;
    return resolvedClient;
  }

  throw new Error(
    "Bridge unavailable: neither window.briefcast nor the local compatibility API bridge was detected. If you are in browser-only mode, run Electron with `npm run dev`."
  );
}

class DynamicClient implements RendererBridge {
  async getSettings(): Promise<AppSettings> {
    return (await resolveClient()).getSettings();
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    return (await resolveClient()).saveSettings(settings);
  }

  async syncNews(): Promise<SyncResult> {
    return (await resolveClient()).syncNews();
  }

  async searchArticles(query: string, mode: SearchMode, limit?: number): Promise<SearchResult[]> {
    return (await resolveClient()).searchArticles(query, mode, limit);
  }

  async preferenceSearch(description: string, limit?: number): Promise<SearchResult[]> {
    return (await resolveClient()).preferenceSearch(description, limit);
  }

  async generateDailyBriefing(): Promise<GenerateBriefingResult> {
    return (await resolveClient()).generateDailyBriefing();
  }

  async getBriefings(limit?: number): Promise<Briefing[]> {
    return (await resolveClient()).getBriefings(limit);
  }

  async getRecommendations(limit?: number): Promise<RecommendationPodcast[]> {
    return (await resolveClient()).getRecommendations(limit);
  }

  async getHistory(limit?: number): Promise<ListenHistoryItem[]> {
    return (await resolveClient()).getHistory(limit);
  }

  async trackHistory(input: HistoryTrackInput): Promise<ListenHistoryItem> {
    return (await resolveClient()).trackHistory(input);
  }

  async getDownloads(limit?: number): Promise<DownloadPodcastItem[]> {
    return (await resolveClient()).getDownloads(limit);
  }

  async saveDownload(input: DownloadSaveInput): Promise<DownloadPodcastItem> {
    return (await resolveClient()).saveDownload(input);
  }

  async removeDownload(id: string): Promise<{ ok: boolean }> {
    return (await resolveClient()).removeDownload(id);
  }

  async getMediaManifest(): Promise<MediaManifest> {
    return (await resolveClient()).getMediaManifest();
  }

  async readMediaResource(name: string, format?: MediaResourceFormat): Promise<MediaResourcePayload> {
    return (await resolveClient()).readMediaResource(name, format);
  }

  async generateEpisode(recommendationId: string): Promise<GeneratedEpisode> {
    return (await resolveClient()).generateEpisode(recommendationId);
  }

  async getTrending(limit?: number): Promise<RecommendationPodcast[]> {
    return (await resolveClient()).getTrending(limit);
  }

  async getDailyPodcast(): Promise<Podcast | null> {
    return (await resolveClient()).getDailyPodcast();
  }

  async forceDailyPodcast(): Promise<Podcast | null> {
    return (await resolveClient()).forceDailyPodcast();
  }

  async generatePodcastAudio(recommendationId: string): Promise<Podcast> {
    return (await resolveClient()).generatePodcastAudio(recommendationId);
  }

  async generateSummaryPodcast(podcastIds: string[]): Promise<Podcast> {
    return (await resolveClient()).generateSummaryPodcast(podcastIds);
  }

  async getPodcastById(podcastId: string): Promise<Podcast | null> {
    return (await resolveClient()).getPodcastById(podcastId);
  }

  async ratePodcast(podcastId: string, rating: number): Promise<void> {
    return (await resolveClient()).ratePodcast(podcastId, rating);
  }

  async getPlaylists(): Promise<PlaylistInfo[]> {
    return (await resolveClient()).getPlaylists();
  }

  async createPlaylist(name: string, description?: string): Promise<PlaylistInfo> {
    return (await resolveClient()).createPlaylist(name, description);
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    return (await resolveClient()).deletePlaylist(playlistId);
  }

  async addToPlaylist(playlistId: string, podcastId: string): Promise<void> {
    return (await resolveClient()).addToPlaylist(playlistId, podcastId);
  }

  async removeFromPlaylist(playlistId: string, podcastId: string): Promise<void> {
    return (await resolveClient()).removeFromPlaylist(playlistId, podcastId);
  }

  async getUserProfile(): Promise<UserProfile> {
    return (await resolveClient()).getUserProfile();
  }

  async updateUserProfile(prefs: Partial<UserPreferenceSettings>): Promise<UserProfile> {
    return (await resolveClient()).updateUserProfile(prefs);
  }

  async getFinancialNews(limit?: number): Promise<SearchResult[]> {
    return (await resolveClient()).getFinancialNews(limit);
  }
}

const dynamicClient = new DynamicClient();

export function getRendererClient(): RendererBridge {
  return dynamicClient;
}
