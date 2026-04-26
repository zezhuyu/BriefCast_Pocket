export type ProviderType = "openai-compatible" | "anthropic" | "codex-cli" | "claude-cli";

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  embeddingModel: string;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

export interface CliProviderConfig {
  command: string;
  argsTemplate: string;
}

export interface ProviderSettings {
  activeProvider: ProviderType;
  openaiCompatible: OpenAiCompatibleConfig;
  anthropic: AnthropicConfig;
  codexCli: CliProviderConfig;
  claudeCli: CliProviderConfig;
}

export interface SourceSettings {
  rssEnabled: boolean;
  rssFeeds: string[];
  hackerNewsEnabled: boolean;
  redditEnabled: boolean;
  redditSubreddits: string[];
  devToEnabled: boolean;
  devToTags: string[];
  lobstersEnabled: boolean;
  googleNewsEnabled: boolean;
  googleNewsTopics: string[];
  githubTrendingEnabled: boolean;
  slashdotEnabled: boolean;
  productHuntEnabled: boolean;
}

export interface UserPreferenceSettings {
  topics: string[];
  region: string;
  language: string;
}

export interface AppSettings {
  providers: ProviderSettings;
  sources: SourceSettings;
  preferences: UserPreferenceSettings;
  tts: TtsSettings;
}

export type TtsProviderType = "openai-compatible" | "system-say";

export interface TtsSettings {
  provider: TtsProviderType;
  voice: string;
  model: string;
  systemVoice: string;
}

export interface Article {
  id: string;
  title: string;
  url: string;
  sourceType: string;
  sourceName: string;
  summary: string;
  content: string;
  publishedAt: number;
  imageUrl?: string;
}

export interface SearchResult extends Article {
  keywordScore?: number;
  semanticScore?: number;
  hybridScore?: number;
}

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface Briefing {
  id: string;
  dateKey: string;
  content: string;
  provider: ProviderType;
  createdAt: number;
}

export interface GenerateBriefingResult {
  briefing: Briefing;
  articlesUsed: SearchResult[];
}

export interface RecommendationPodcast {
  id: string;
  title: string;
  subcategory: string;
  sourceName: string;
  sourceType: string;
  summary: string;
  url: string;
  publishedAt: number;
  estimatedDurationSeconds: number;
  imageResource: string;
  imageUrl?: string;
}

export interface ListenHistoryItem {
  id: string;
  recommendationId: string;
  title: string;
  subcategory: string;
  sourceName: string;
  url: string;
  imageResource: string;
  imageUrl?: string;
  progressSeconds: number;
  durationSeconds: number;
  listenedAt: number;
}

export interface DownloadPodcastItem {
  id: string;
  recommendationId: string;
  title: string;
  subcategory: string;
  sourceName: string;
  url: string;
  summary: string;
  imageResource: string;
  imageUrl?: string;
  audioResource: string;
  lyricsResource: string;
  savedAt: number;
}

export interface HistoryTrackInput {
  recommendationId: string;
  progressSeconds?: number;
  durationSeconds?: number;
}

export interface DownloadSaveInput {
  recommendationId: string;
  imageResource?: string;
  audioResource?: string;
  lyricsResource?: string;
}

export type MediaResourceFormat = "base64" | "text";

export interface MediaManifest {
  resourceDir: string;
  images: string[];
  audio: string[];
  lyrics: string[];
  defaults: {
    speakerImage: string;
    backgroundMusic: string;
    lyrics: string;
  };
}

export interface MediaResourcePayload {
  name: string;
  mimeType: string;
  format: MediaResourceFormat;
  content: string;
}

export interface GeneratedEpisode {
  recommendationId: string;
  transcript: string;
  lyricsLrc: string;
  audioMimeType: string;
  audioBase64: string;
}

// ── New types for web-parity UI ──────────────────────────────────────────────

/** A podcast episode ready for playback (generated audio + transcript). */
export interface Podcast {
  id: string;
  title: string;
  subcategory: string;
  source_name: string;
  image_url: string;
  audio_url: string;       // file:// or data: URL
  transcript_url: string;  // file:// URL to .lrc
  duration_seconds: number;
  published_at: number;    // unix ms
  link?: string;
  rating?: number;         // -1 | 0 | 1
  listen_duration_seconds?: number;
  stop_position_seconds?: number;
  listened_at?: number;    // unix ms
  is_daily?: boolean;
  is_summary?: boolean;
}

export interface PlaylistItem {
  id: string;
  title: string;
  subcategory: string;
  image_url: string;
  audio_url: string;
  transcript_url: string;
  duration_seconds: number;
  published_at: number;
}

export interface PlaylistInfo {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  items: PlaylistItem[];
}

export interface UserProfile {
  id: string;
  preference: { topics: string[]; region: string; language: string };
  location?: [number, number];
}

export interface PodcastGenerationStatus {
  id: string;
  status: "pending" | "generating" | "ready" | "error";
  progress?: number;  // 0-100
  message?: string;
  podcast?: Podcast;
}

// ── Extended RendererBridge ───────────────────────────────────────────────────

export interface RendererBridge {
  // Settings
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;

  // News
  syncNews(): Promise<SyncResult>;
  searchArticles(query: string, mode: SearchMode, limit?: number): Promise<SearchResult[]>;
  preferenceSearch(description: string, limit?: number): Promise<SearchResult[]>;
  getFinancialNews(limit?: number): Promise<SearchResult[]>;

  // Briefing (text)
  generateDailyBriefing(): Promise<GenerateBriefingResult>;
  getBriefings(limit?: number): Promise<Briefing[]>;

  // Library
  getRecommendations(limit?: number): Promise<RecommendationPodcast[]>;
  getTrending(limit?: number): Promise<RecommendationPodcast[]>;

  // History
  getHistory(limit?: number): Promise<ListenHistoryItem[]>;
  trackHistory(input: HistoryTrackInput): Promise<ListenHistoryItem>;

  // Downloads
  getDownloads(limit?: number): Promise<DownloadPodcastItem[]>;
  saveDownload(input: DownloadSaveInput): Promise<DownloadPodcastItem>;
  removeDownload(id: string): Promise<{ ok: boolean }>;

  // Media resources
  getMediaManifest(): Promise<MediaManifest>;
  readMediaResource(name: string, format?: MediaResourceFormat): Promise<MediaResourcePayload>;

  // Podcast audio generation
  generateEpisode(recommendationId: string): Promise<GeneratedEpisode>;
  getDailyPodcast(): Promise<Podcast | null>;
  forceDailyPodcast(): Promise<Podcast | null>;
  generatePodcastAudio(recommendationId: string): Promise<Podcast>;
  generateSummaryPodcast(podcastIds: string[]): Promise<Podcast>;
  getPodcastById(podcastId: string): Promise<Podcast | null>;
  ratePodcast(podcastId: string, rating: number): Promise<void>;

  // Playlists
  getPlaylists(): Promise<PlaylistInfo[]>;
  createPlaylist(name: string, description?: string): Promise<PlaylistInfo>;
  deletePlaylist(playlistId: string): Promise<void>;
  addToPlaylist(playlistId: string, podcastId: string): Promise<void>;
  removeFromPlaylist(playlistId: string, podcastId: string): Promise<void>;

  // User profile
  getUserProfile(): Promise<UserProfile>;
  updateUserProfile(prefs: Partial<UserPreferenceSettings>): Promise<UserProfile>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  providers: {
    activeProvider: "openai-compatible",
    openaiCompatible: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4.1-mini",
      embeddingModel: "text-embedding-3-small"
    },
    anthropic: {
      apiKey: "",
      model: "claude-3-5-sonnet-latest"
    },
    codexCli: {
      command: "codex",
      argsTemplate: "exec {prompt}"
    },
    claudeCli: {
      command: "claude",
      argsTemplate: "-p {prompt}"
    }
  },
  sources: {
    rssEnabled: true,
    rssFeeds: [
      "https://feeds.bbci.co.uk/news/world/rss.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
      "https://feeds.npr.org/1004/rss.xml"
    ],
    hackerNewsEnabled: true,
    redditEnabled: true,
    redditSubreddits: ["worldnews", "technology", "business"],
    devToEnabled: true,
    devToTags: ["news", "technology", "webdev", "ai", "programming"],
    lobstersEnabled: true,
    googleNewsEnabled: true,
    googleNewsTopics: ["technology", "business", "world", "science"],
    githubTrendingEnabled: true,
    slashdotEnabled: true,
    productHuntEnabled: true
  },
  preferences: {
    topics: ["technology", "business", "world"],
    region: "US",
    language: "en"
  },
  tts: {
    provider: "openai-compatible",
    voice: "alloy",
    model: "gpt-4o-mini-tts",
    systemVoice: "Samantha"
  }
};
