import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ConfigStore } from "./configStore";
import { BriefcastDb } from "./db";
import { LegacyStateService, LegacyRssLink } from "./legacyState";
import { MediaResourceService } from "./mediaResources";
import { dedupeArticles, enrichWithArticleImages, fetchDevTo, fetchGithubTrending, fetchGoogleNews, fetchHackerNews, fetchLobsters, fetchProductHunt, fetchReddit, fetchRssNews, fetchSlashdot } from "./newsSources";
import { embedText, generateText, synthesizeSpeech } from "./providers";
import { generateDailyPodcast } from "./podcastPipeline";
import {
  AppSettings,
  Briefing,
  DownloadPodcastItem,
  DownloadSaveInput,
  GeneratedEpisode,
  GenerateBriefingResult,
  HistoryTrackInput,
  ListenHistoryItem,
  MediaManifest,
  MediaResourceFormat,
  MediaResourcePayload,
  Podcast,
  PlaylistInfo,
  PlaylistItem,
  RecommendationPodcast,
  SearchMode,
  SearchResult,
  SyncResult,
  UserPreferenceSettings,
  UserProfile
} from "../../shared/types";

/** Resolve device location as "lat,lon" string via IP geolocation (silent fallback). */
async function getIpLocation(): Promise<string | null> {
  try {
    const res = await fetch("https://ipapi.co/json/", {
      headers: { "User-Agent": "BriefCast/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { latitude?: number; longitude?: number };
    if (typeof data.latitude === "number" && typeof data.longitude === "number") {
      return `${data.latitude.toFixed(2)},${data.longitude.toFixed(2)}`;
    }
    return null;
  } catch {
    return null;
  }
}

function dateKeyNow(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function clip(text: string, max = 1600): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function buildBriefingPrompt(topics: string[], articles: SearchResult[], todayKey: string): string {
  const topicLine = topics.length ? topics.join(", ") : "general news";
  const articleLines = articles
    .map(
      (article, idx) =>
        `${idx + 1}. ${article.title}\nSource: ${article.sourceName} (${article.sourceType})\nURL: ${article.url}\nSummary: ${clip(article.summary || article.content || article.title, 420)}`
    )
    .join("\n\n");

  return [
    `Create a daily news briefing for ${todayKey}.`,
    `Audience preferences: ${topicLine}.`,
    "Use only the provided items and avoid fabricated facts.",
    "Output format:",
    "- Top 6 headlines with 1-2 sentence explanations",
    "- A short section: Why this matters today",
    "- A short section: Watchlist for tomorrow",
    "News items:",
    articleLines
  ].join("\n\n");
}

function localFallbackBriefing(articles: SearchResult[], todayKey: string): string {
  const lines = articles.slice(0, 8).map((article, idx) => {
    const oneLine = clip(article.summary || article.content || "No summary available", 180);
    return `${idx + 1}. ${article.title} (${article.sourceName})\n${oneLine}\n${article.url}`;
  });

  return [
    `Daily briefing (${todayKey})`,
    "",
    "Top headlines:",
    ...lines,
    "",
    "Why this matters today:",
    "These stories are ranked from your configured topics and recent publication time.",
    "",
    "Watchlist for tomorrow:",
    "Look for updates on the top geopolitical, market, and technology headlines above."
  ].join("\n");
}

interface LegacyPodcast {
  id: string;
  title: string;
  show: string;
  episode: string;
  duration: string;
  duration_seconds: number;
  listen_duration_seconds: number;
  image_url: string;
  transcript_url: string;
  audio_url: string;
  category: string;
  subcategory: string;
  positive_rating: number;
  negative_rating: number;
  total_rating: number;
  createAt: number;
  added_at: number;
  favorite: boolean;
  published_at: number;
  link: string;
}

export class BriefcastAppService {
  private readonly configStore: ConfigStore;
  private readonly db: BriefcastDb;
  private readonly legacyState: LegacyStateService;
  private readonly mediaResources: MediaResourceService;
  private readonly generatedEpisodes: Map<string, GeneratedEpisode>;
  private readonly legacyPodcastCache: Map<string, LegacyPodcast>;
  private readonly legacyNowPlaying: Map<string, { podcastId: string; position: number; updatedAt: number }>;
  private readonly legacyDailyCache: Map<string, LegacyPodcast>;
  private readonly legacyDailyInFlight: Set<string>;
  private settings: AppSettings;
  // Write-through in-memory cache backed by SQLite
  private readonly podcastCache: Map<string, Podcast>;
  private dailyInFlight: boolean;
  private currentDailyDateKey: string;
  private readonly baseDir: string;
  // Shared promise so concurrent ensureSeedNews callers wait for the same sync
  private seedNewsPromise: Promise<void> | null = null;

  constructor(baseDir: string) {
    this.configStore = new ConfigStore(baseDir);
    this.db = new BriefcastDb(baseDir);
    this.legacyState = new LegacyStateService(baseDir);
    this.mediaResources = new MediaResourceService();
    this.generatedEpisodes = new Map();
    this.legacyPodcastCache = new Map();
    this.legacyNowPlaying = new Map();
    this.legacyDailyCache = new Map();
    this.legacyDailyInFlight = new Set();
    this.settings = this.configStore.load();
    this.podcastCache = new Map();
    this.dailyInFlight = false;
    this.currentDailyDateKey = "";
    this.baseDir = baseDir;
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  saveSettings(input: AppSettings): AppSettings {
    this.settings = this.configStore.save(input);
    return this.settings;
  }

  async syncNews(): Promise<SyncResult> {
    const all = [];
    const sourceErrors: string[] = [];
    const fallbackRssFeeds = this.legacyState
      .getRssLinks()
      .map((item) => item.link)
      .filter((item) => /^https?:\/\//.test(item));
    const rssFeeds = this.settings.sources.rssFeeds.length ? this.settings.sources.rssFeeds : fallbackRssFeeds;

    console.log("[syncNews] sources enabled — rss:", this.settings.sources.rssEnabled, "hn:", this.settings.sources.hackerNewsEnabled, "reddit:", this.settings.sources.redditEnabled);
    console.log("[syncNews] rssFeeds count:", rssFeeds.length, "| custom:", this.settings.sources.rssFeeds.length, "| fallback:", fallbackRssFeeds.length);

    if (this.settings.sources.rssEnabled && rssFeeds.length) {
      console.log("[syncNews] fetching RSS from", rssFeeds.length, "feeds…");
      try {
        const rss = await fetchRssNews(rssFeeds, 30);
        console.log("[syncNews] RSS returned", rss.length, "articles");
        all.push(...rss);
      } catch (error) {
        sourceErrors.push(`rss:${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log("[syncNews] RSS skipped (enabled:", this.settings.sources.rssEnabled, "feeds:", rssFeeds.length, ")");
    }

    if (this.settings.sources.hackerNewsEnabled) {
      console.log("[syncNews] fetching Hacker News…");
      try {
        const hn = await fetchHackerNews(40);
        console.log("[syncNews] HN returned", hn.length, "articles");
        all.push(...hn);
      } catch (error) {
        sourceErrors.push(`hackernews:${error instanceof Error ? error.message : String(error)}`);
        console.error("[syncNews] HN error:", error);
      }
    }

    if (this.settings.sources.redditEnabled && this.settings.sources.redditSubreddits.length) {
      console.log("[syncNews] fetching Reddit subreddits:", this.settings.sources.redditSubreddits);
      try {
        const reddit = await fetchReddit(this.settings.sources.redditSubreddits, 20);
        console.log("[syncNews] Reddit returned", reddit.length, "articles");
        all.push(...reddit);
      } catch (error) {
        sourceErrors.push(`reddit:${error instanceof Error ? error.message : String(error)}`);
        console.error("[syncNews] Reddit error:", error);
      }
    }

    if (this.settings.sources.devToEnabled) {
      const tags = this.settings.sources.devToTags.length ? this.settings.sources.devToTags : ["news", "technology"];
      console.log("[syncNews] fetching Dev.to tags:", tags);
      try {
        const devto = await fetchDevTo(tags, 15);
        console.log("[syncNews] Dev.to returned", devto.length, "articles");
        all.push(...devto);
      } catch (error) {
        sourceErrors.push(`devto:${error instanceof Error ? error.message : String(error)}`);
        console.error("[syncNews] Dev.to error:", error);
      }
    }

    if (this.settings.sources.lobstersEnabled) {
      console.log("[syncNews] fetching Lobste.rs…");
      try {
        const lobsters = await fetchLobsters(40);
        console.log("[syncNews] Lobste.rs returned", lobsters.length, "articles");
        all.push(...lobsters);
      } catch (error) {
        sourceErrors.push(`lobsters:${error instanceof Error ? error.message : String(error)}`);
        console.error("[syncNews] Lobste.rs error:", error);
      }
    }

    if (this.settings.sources.googleNewsEnabled) {
      const topics = this.settings.sources.googleNewsTopics.length ? this.settings.sources.googleNewsTopics : ["technology", "world"];
      console.log("[syncNews] fetching Google News topics:", topics);
      try {
        const gnews = await fetchGoogleNews(topics, 15);
        console.log("[syncNews] Google News returned", gnews.length, "articles");
        all.push(...gnews);
      } catch (error) {
        sourceErrors.push(`googlenews:${error instanceof Error ? error.message : String(error)}`);
        console.error("[syncNews] Google News error:", error);
      }
    }

    if (this.settings.sources.githubTrendingEnabled) {
      console.log("[syncNews] fetching GitHub Trending…");
      try {
        const gh = await fetchGithubTrending(25);
        console.log("[syncNews] GitHub Trending returned", gh.length, "articles");
        all.push(...gh);
      } catch (error) {
        sourceErrors.push(`github-trending:${error instanceof Error ? error.message : String(error)}`);
        console.error("[syncNews] GitHub Trending error:", error);
      }
    }

    if (this.settings.sources.slashdotEnabled) {
      console.log("[syncNews] fetching Slashdot…");
      try {
        const slashdot = await fetchSlashdot(20);
        console.log("[syncNews] Slashdot returned", slashdot.length, "articles");
        all.push(...slashdot);
      } catch (error) {
        sourceErrors.push(`slashdot:${error instanceof Error ? error.message : String(error)}`);
        console.error("[syncNews] Slashdot error:", error);
      }
    }

    if (this.settings.sources.productHuntEnabled) {
      console.log("[syncNews] fetching ProductHunt…");
      try {
        const ph = await fetchProductHunt(25);
        console.log("[syncNews] ProductHunt returned", ph.length, "articles");
        all.push(...ph);
      } catch (error) {
        sourceErrors.push(`producthunt:${error instanceof Error ? error.message : String(error)}`);
        console.error("[syncNews] ProductHunt error:", error);
      }
    }

    const deduped = dedupeArticles(all);
    console.log("[syncNews] total fetched:", all.length, "after dedup:", deduped.length);

    // Scrape og:image from article pages for any articles missing an image
    await enrichWithArticleImages(deduped);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    const embeddingModel =
      this.settings.providers.activeProvider === "openai-compatible"
        ? this.settings.providers.openaiCompatible.embeddingModel || "local-hash-v1"
        : "local-hash-v1";

    for (const article of deduped) {
      // Skip articles already in DB — no need to re-embed on periodic syncs
      if (this.db.articleExistsByUrl(article.url)) {
        skipped += 1;
        continue;
      }

      // Embed the title as the primary semantic signal, followed by summary and content
      const searchable = `${article.title}\n${article.summary}\n${article.content}`.trim();
      if (!searchable || searchable.length < 12) {
        skipped += 1;
        continue;
      }

      const vector = await embedText(this.settings, searchable);
      const status = this.db.upsertArticle(article, vector, embeddingModel);

      if (status === "inserted") {
        inserted += 1;
      } else {
        updated += 1;
      }
    }

    if (sourceErrors.length) {
      console.warn("[syncNews] source errors:", sourceErrors.join("; "));
    }
    console.log(`[syncNews] done — inserted:${inserted} updated:${updated} skipped:${skipped}`);

    return {
      fetched: deduped.length,
      inserted,
      updated,
      skipped
    };
  }

  async searchArticles(query: string, mode: SearchMode, limit = 30): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return this.db.recentArticles(limit);
    }

    if (mode === "keyword") {
      return this.db.keywordSearch(trimmed, limit);
    }

    const queryVector = await embedText(this.settings, trimmed);

    if (mode === "semantic") {
      return this.db.semanticSearch(queryVector, limit);
    }

    return this.db.hybridSearch(trimmed, queryVector, limit);
  }

  /**
   * Returns articles filtered to financial topics (markets, economy, stocks, crypto, etc.).
   * Uses FTS5 with financial keywords, then re-ranks by recency.
   */
  async getFinancialNews(limit = 30): Promise<SearchResult[]> {
    await this.ensureSeedNews();
    return this.db.financialNews(limit);
  }

  /**
   * Preference-based semantic search.
   * Accepts a free-text description of user interests (generated by an AI agent),
   * embeds it with the configured embedding model, and returns the most relevant articles.
   */
  async preferenceSearch(description: string, limit = 20): Promise<SearchResult[]> {
    const trimmed = description.trim();
    if (!trimmed) return this.db.recentArticles(limit);
    const vector = await embedText(this.settings, trimmed);
    return this.db.semanticSearch(vector, limit);
  }

  async generateDailyBriefing(): Promise<GenerateBriefingResult> {
    const topics = this.settings.preferences.topics.filter(Boolean);
    console.log("[briefing] starting — provider:", this.settings.providers.activeProvider, "topics:", topics);

    const gathered = new Map<string, SearchResult>();

    if (topics.length) {
      for (const topic of topics) {
        console.log("[briefing] embedding topic:", topic);
        const queryVector = await embedText(this.settings, topic);
        const matches = this.db.hybridSearch(topic, queryVector, 8);
        console.log(`[briefing] topic "${topic}" → ${matches.length} articles`);
        for (const item of matches) {
          gathered.set(item.id, item);
        }
      }
    }

    if (!gathered.size) {
      console.log("[briefing] no topic matches — falling back to recent articles");
      for (const item of this.db.recentArticles(20)) {
        gathered.set(item.id, item);
      }
    }

    const articlesUsed = [...gathered.values()]
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 20);

    console.log(`[briefing] gathered ${articlesUsed.length} articles for prompt`);

    const todayKey = dateKeyNow();
    const prompt = buildBriefingPrompt(topics, articlesUsed, todayKey);
    console.log("[briefing] prompt length:", prompt.length, "chars — calling generateText...");

    let content: string;
    try {
      content = await generateText(this.settings, prompt);
      console.log("[briefing] generateText returned", content.length, "chars");
    } catch (err) {
      console.error("[briefing] generateText failed:", err);
      console.log("[briefing] using local fallback briefing");
      content = localFallbackBriefing(articlesUsed, todayKey);
    }

    const briefing = this.db.saveBriefing(todayKey, content, this.settings.providers.activeProvider);
    console.log("[briefing] saved briefing id:", briefing.id);
    return { briefing, articlesUsed };
  }

  getBriefings(limit = 10): Briefing[] {
    return this.db.getBriefings(limit);
  }

  /**
   * Summarises what the user has actually been engaging with:
   * - Articles listened to ≥ 60% completion in the last 30 days
   * - Source types with the most completions
   * - Sources from positively rated podcasts
   * Returns an empty string when no behavioral data exists yet.
   */
  private buildBehavioralSignalSummary(): string {
    const engaged = this.db.getEngagedHistory(30, 0.6);
    const sourceTypes = this.db.getEngagedSourceTypes(30);
    const ratedSources = this.db.getPositivelyRatedSources();

    if (!engaged.length && !ratedSources.length) return "";

    const sourceNameCounts = new Map<string, number>();
    for (const h of engaged) {
      if (h.source_name) {
        sourceNameCounts.set(h.source_name, (sourceNameCounts.get(h.source_name) ?? 0) + 1);
      }
    }
    const topSources = [...sourceNameCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count})`);

    const parts: string[] = [];
    if (engaged.length) {
      parts.push(`User completed ${engaged.length} articles (≥60%) in the last 30 days.`);
    }
    if (topSources.length) {
      parts.push(`Most engaged sources: ${topSources.join(", ")}.`);
    }
    if (sourceTypes.length) {
      parts.push(`Top content types by engagement: ${sourceTypes.slice(0, 3).map(r => `${r.source_type} (${r.count})`).join(", ")}.`);
    }
    if (ratedSources.length) {
      const ratedNames = [...new Set(ratedSources.map(r => r.source_name).filter(Boolean))].slice(0, 3);
      if (ratedNames.length) parts.push(`Positively rated sources: ${ratedNames.join(", ")}.`);
    }

    return parts.join(" ");
  }

  /**
   * Build a rich natural-language preference description by asking the LLM.
   * Blends manual topic settings with behavioral signals (listen completion + ratings).
   * Falls back to a template string if the LLM call fails or isn't configured.
   */
  private async buildPreferenceDescription(): Promise<string> {
    const { topics, region, language } = this.settings.preferences;
    const topicList = topics.filter(Boolean).join(", ") || "general news";
    const behaviorSummary = this.buildBehavioralSignalSummary();

    // Template fallback (used when LLM unavailable)
    const fallback = `News articles about ${topicList} relevant to a reader in ${region || "the US"} who prefers content in ${language || "English"}. Focus on recent developments, analysis, and key events.`;

    try {
      const promptLines = [
        "You are helping a personalized news podcast app select relevant articles for a user.",
        "Write a 2-3 sentence description of what this user wants to read, for use as a semantic search query.",
        "Be specific about topics, tone, and recency. Output only the description text, no labels.",
        "",
        `User preferences:`,
        `  Topics of interest: ${topicList}`,
        `  Region: ${region || "US"}`,
        `  Language: ${language || "English"}`,
      ];
      if (behaviorSummary) {
        promptLines.push("", "Behavioral signals (use to refine the description):", `  ${behaviorSummary}`);
      }

      const description = await generateText(this.settings, promptLines.join("\n"));
      const trimmed = description.trim();
      console.log("[getRecommendations] AI preference description:", trimmed.slice(0, 120) + "…");
      return trimmed || fallback;
    } catch (err) {
      console.warn("[getRecommendations] AI preference description failed, using template fallback:", err instanceof Error ? err.message : err);
      return fallback;
    }
  }

  /**
   * Analyzes recent listening behavior and positive ratings, then asks the LLM to
   * suggest updated topic keywords. Saves the result back to settings so future
   * briefings and recommendations reflect actual usage.
   * Called once daily by the scheduler. No-ops if there is no behavioral data yet.
   */
  async refreshTopicsFromBehavior(): Promise<void> {
    const behaviorSummary = this.buildBehavioralSignalSummary();
    if (!behaviorSummary) {
      console.log("[preference-refresh] no behavioral data yet — skipping");
      return;
    }

    const currentTopics = this.settings.preferences.topics.join(", ") || "general news";
    const prompt = [
      "You are updating a personalized news podcast app's topic preferences based on user listening behavior.",
      "Suggest 3-6 concise topic keywords that best capture this user's interests.",
      'Output ONLY a JSON array of strings. Example: ["artificial intelligence", "startups", "climate"]',
      "",
      `Current manual topics: ${currentTopics}`,
      `Behavioral signals: ${behaviorSummary}`,
    ].join("\n");

    try {
      const response = await generateText(this.settings, prompt);
      const match = response.match(/\[[\s\S]*?\]/);
      if (!match) {
        console.warn("[preference-refresh] LLM response had no JSON array:", response.slice(0, 100));
        return;
      }
      const parsed = JSON.parse(match[0]) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) return;
      const topics = (parsed as string[]).map((t) => t.trim()).filter(Boolean).slice(0, 6);
      if (!topics.length) return;

      this.settings.preferences.topics = topics;
      this.configStore.save(this.settings);
      console.log("[preference-refresh] topics updated from behavior:", topics);
    } catch (err) {
      console.warn("[preference-refresh] failed:", err instanceof Error ? err.message : err);
    }
  }

  async getRecommendations(limit = 100): Promise<RecommendationPodcast[]> {
    await this.ensureSeedNews();
    const manifest = await this.mediaResources.getManifest();
    const imageResource = manifest.defaults.speakerImage || "default.png";

    // Use AI-generated preference description + semantic search for ranking
    const preferenceDescription = await this.buildPreferenceDescription();
    console.log("[getRecommendations] running preference search with description length:", preferenceDescription.length);

    let semanticResults: SearchResult[] = [];
    try {
      semanticResults = await this.preferenceSearch(preferenceDescription, Math.max(limit * 2, 200));
      console.log("[getRecommendations] preference search returned:", semanticResults.length, "results");
    } catch (err) {
      console.warn("[getRecommendations] preference search failed, falling back to recency ranking:", err instanceof Error ? err.message : err);
    }

    const historySeen = new Set(this.db.getHistory(600).map((item) => item.recommendationId));

    if (semanticResults.length) {
      // Convert SearchResult → RecommendationPodcast, filter already-seen
      const filtered = semanticResults
        .filter((r) => !historySeen.has(r.id))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          title: r.title,
          subcategory: r.sourceName,
          sourceName: r.sourceName,
          sourceType: r.sourceType,
          summary: r.summary,
          url: r.url,
          publishedAt: r.publishedAt,
          estimatedDurationSeconds: 180,
          imageResource,
          imageUrl: r.imageUrl,
        } as RecommendationPodcast));

      if (filtered.length) {
        return filtered;
      }
    }

    // Fallback: plain recency-ordered candidates from DB
    const candidates = this.db.getRecommendations(Math.max(limit * 4, 160), imageResource);
    console.log("[getRecommendations] fallback candidates from DB:", candidates.length);
    if (!candidates.length) {
      console.warn("[getRecommendations] no articles in DB — library will be empty");
      return [];
    }

    return candidates
      .filter((item) => !historySeen.has(item.id))
      .slice(0, limit);
  }

  getHistory(limit = 200): ListenHistoryItem[] {
    return this.db.getHistory(limit);
  }

  async trackHistory(input: HistoryTrackInput): Promise<ListenHistoryItem> {
    const manifest = await this.mediaResources.getManifest();
    const imageResource = manifest.defaults.speakerImage || "default.png";
    return this.db.trackHistory(input, imageResource);
  }

  getDownloads(limit = 500): DownloadPodcastItem[] {
    return this.db.getDownloads(limit);
  }

  async saveDownload(input: DownloadSaveInput): Promise<DownloadPodcastItem> {
    const manifest = await this.mediaResources.getManifest();
    return this.db.saveDownload(input, {
      imageResource: input.imageResource || manifest.defaults.speakerImage || "default.png",
      audioResource: input.audioResource || manifest.defaults.backgroundMusic || "starting.wav",
      lyricsResource: input.lyricsResource || manifest.defaults.lyrics || "starting.lrc"
    });
  }

  removeDownload(id: string): { ok: boolean } {
    return { ok: this.db.removeDownload(id) };
  }

  private buildTranscriptPrompt(recommendation: RecommendationPodcast): string {
    return [
      "Write a podcast narration transcript for one news story.",
      "Style: clear, concise, factual, no fluff, no markdown.",
      "Output plain transcript text only.",
      `Title: ${recommendation.title}`,
      `Source: ${recommendation.sourceName} (${recommendation.sourceType})`,
      `Summary: ${recommendation.summary}`,
      `URL: ${recommendation.url}`
    ].join("\n");
  }

  private toLrc(transcript: string): string {
    const chunks = transcript
      .split(/(?<=[.!?])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);

    let cursor = 0;
    return chunks
      .map((line) => {
        const min = Math.floor(cursor / 60)
          .toString()
          .padStart(2, "0");
        const sec = Math.floor(cursor % 60)
          .toString()
          .padStart(2, "0");
        cursor += Math.max(3, Math.min(9, Math.ceil(line.length / 18)));
        return `[${min}:${sec}.00]${line}`;
      })
      .join("\n");
  }

  async generateEpisode(recommendationId: string): Promise<GeneratedEpisode> {
    const cached = this.generatedEpisodes.get(recommendationId);
    if (cached) {
      return cached;
    }

    const manifest = await this.mediaResources.getManifest();
    const recommendation = this.db.getRecommendationById(recommendationId, manifest.defaults.speakerImage || "default.png");
    if (!recommendation) {
      throw new Error(`Recommendation not found: ${recommendationId}`);
    }

    const prompt = this.buildTranscriptPrompt(recommendation);
    const transcript = await generateText(this.settings, prompt);
    const lrc = this.toLrc(transcript);
    const audio = await synthesizeSpeech(this.settings, transcript);

    const episode: GeneratedEpisode = {
      recommendationId,
      transcript,
      lyricsLrc: lrc,
      audioMimeType: audio.mimeType,
      audioBase64: audio.buffer.toString("base64")
    };

    this.generatedEpisodes.set(recommendationId, episode);
    return episode;
  }

  private formatLegacyDuration(durationSeconds: number): string {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return "2";
    }
    return String(Math.max(1, Math.round(durationSeconds / 60)));
  }

  private buildLegacyPodcastFromRecommendation(
    recommendation: RecommendationPodcast,
    defaults: { image: string; audio: string; transcript: string },
    listenDuration = 0,
    favorite = false
  ): LegacyPodcast {
    return {
      id: recommendation.id,
      title: recommendation.title,
      show: recommendation.sourceName,
      episode: recommendation.sourceType,
      duration: this.formatLegacyDuration(recommendation.estimatedDurationSeconds),
      duration_seconds: recommendation.estimatedDurationSeconds,
      listen_duration_seconds: Math.max(0, Math.floor(listenDuration)),
      image_url: `image/${defaults.image}`,
      transcript_url: `transcript/${defaults.transcript}`,
      audio_url: `audio/${defaults.audio}`,
      category: recommendation.sourceType,
      subcategory: recommendation.subcategory,
      positive_rating: 0,
      negative_rating: 0,
      total_rating: 0,
      createAt: recommendation.publishedAt,
      added_at: recommendation.publishedAt,
      favorite,
      published_at: recommendation.publishedAt,
      link: recommendation.url
    };
  }

  private async getLegacyDefaults(): Promise<{ image: string; audio: string; transcript: string }> {
    const manifest = await this.mediaResources.getManifest();
    return {
      image: manifest.defaults.speakerImage || "default.png",
      audio: manifest.defaults.backgroundMusic || "starting.wav",
      transcript: manifest.defaults.lyrics || "starting.lrc"
    };
  }

  private async ensureSeedNews(): Promise<void> {
    const existing = this.db.recentArticles(1);
    if (existing.length) {
      return;
    }
    // Deduplicate concurrent callers — only one sync runs at a time
    if (!this.seedNewsPromise) {
      console.log("[ensureSeedNews] DB empty — triggering syncNews");
      this.seedNewsPromise = this.syncNews()
        .then(() => { this.seedNewsPromise = null; })
        .catch((err) => { this.seedNewsPromise = null; throw err; });
    } else {
      console.log("[ensureSeedNews] sync already in progress, waiting…");
    }
    await this.seedNewsPromise;
  }

  async getLegacyRecommendations(podcastId?: string, limit = 20): Promise<LegacyPodcast[]> {
    await this.ensureSeedNews();
    const defaults = await this.getLegacyDefaults();
    const list = await this.getRecommendations(Math.max(limit * 3, 120));
    const filtered = list.filter((item) => item.id !== podcastId).slice(0, limit);
    return filtered.map((item) => this.buildLegacyPodcastFromRecommendation(item, defaults));
  }

  async getLegacyTrending(limit = 20): Promise<LegacyPodcast[]> {
    const recommendations = await this.getLegacyRecommendations(undefined, Math.max(limit * 2, 40));
    return recommendations.sort((a, b) => b.published_at - a.published_at).slice(0, limit);
  }

  async getLegacySearch(query: string, limit = 20): Promise<LegacyPodcast[]> {
    const defaults = await this.getLegacyDefaults();
    const found = await this.searchArticles(query, "hybrid", limit);
    return found.map((item) =>
      this.buildLegacyPodcastFromRecommendation(
        {
          id: item.id,
          title: item.title,
          subcategory: item.sourceName,
          sourceName: item.sourceName,
          sourceType: item.sourceType,
          summary: item.summary || item.content,
          url: item.url,
          publishedAt: item.publishedAt,
          estimatedDurationSeconds: 180,
          imageResource: defaults.image
        },
        defaults
      )
    );
  }

  async getLegacyPodcast(podcastId: string): Promise<LegacyPodcast | null> {
    if (!podcastId) {
      return null;
    }

    const cached = this.legacyPodcastCache.get(podcastId);
    if (cached) {
      return cached;
    }

    const defaults = await this.getLegacyDefaults();
    const recommendation = this.db.getRecommendationById(podcastId, defaults.image);
    if (!recommendation) {
      return null;
    }
    return this.buildLegacyPodcastFromRecommendation(recommendation, defaults);
  }

  async generateLegacyPodcast(location?: [number, number] | number[], force = false): Promise<LegacyPodcast> {
    void location;
    await this.ensureSeedNews();
    const userId = "default-user";
    const todayKey = dateKeyNow();
    const cacheKey = `${userId}:${todayKey}`;
    const existing = this.legacyDailyCache.get(cacheKey);
    if (existing && !force) {
      return existing;
    }

    const defaults = await this.getLegacyDefaults();
    const placeholderId = `daily-${todayKey}`;
    const placeholder: LegacyPodcast = {
      id: placeholderId,
      title: `Briefcast Daily News ${todayKey}`,
      show: "BriefCast",
      episode: "daily",
      duration: "2",
      duration_seconds: 120,
      listen_duration_seconds: 0,
      image_url: `image/${defaults.image}`,
      transcript_url: "",
      audio_url: "",
      category: "general",
      subcategory: "general",
      positive_rating: 0,
      negative_rating: 0,
      total_rating: 0,
      createAt: Date.now(),
      added_at: Date.now(),
      favorite: false,
      published_at: Date.now(),
      link: ""
    };
    this.legacyPodcastCache.set(placeholder.id, placeholder);

    if (!this.legacyDailyInFlight.has(cacheKey)) {
      this.legacyDailyInFlight.add(cacheKey);
      void (async () => {
        try {
          const recommendations = await this.getRecommendations(1);
          if (!recommendations.length) {
            this.legacyDailyCache.set(cacheKey, placeholder);
            return;
          }

          const top = recommendations[0];
          const generated = await this.generateEpisode(top.id);
          const durationSeconds = Math.max(90, Math.round(generated.transcript.split(/\s+/).length / 2.5));
          const completed: LegacyPodcast = {
            id: placeholderId,
            title: `Briefcast Daily News ${todayKey}`,
            show: "BriefCast",
            episode: "daily",
            duration: this.formatLegacyDuration(durationSeconds),
            duration_seconds: durationSeconds,
            listen_duration_seconds: 0,
            image_url: top.imageResource ? `image/${top.imageResource}` : `image/${defaults.image}`,
            transcript_url: `transcript/${defaults.transcript}`,
            audio_url: `audio/${defaults.audio}`,
            category: top.sourceType,
            subcategory: top.subcategory,
            positive_rating: 0,
            negative_rating: 0,
            total_rating: 0,
            createAt: Date.now(),
            added_at: Date.now(),
            favorite: false,
            published_at: Date.now(),
            link: top.url
          };

          this.legacyDailyCache.set(cacheKey, completed);
          this.legacyPodcastCache.set(completed.id, completed);
        } catch {
          this.legacyDailyCache.set(cacheKey, placeholder);
        } finally {
          this.legacyDailyInFlight.delete(cacheKey);
        }
      })();
    }

    return force ? placeholder : existing ?? placeholder;
  }

  async getLegacyTransition(id1: string, id2: string): Promise<LegacyPodcast> {
    const defaults = await this.getLegacyDefaults();
    const transition: LegacyPodcast = {
      id: "",
      title: "Sofia Lane",
      show: "BriefCast",
      episode: `${id1}-${id2}`,
      duration: "1",
      duration_seconds: 15,
      listen_duration_seconds: 0,
      image_url: `image/${defaults.image}`,
      transcript_url: `transcript/${defaults.transcript}`,
      audio_url: `audio/${defaults.audio}`,
      category: "transition",
      subcategory: "transition",
      positive_rating: 0,
      negative_rating: 0,
      total_rating: 0,
      createAt: Date.now(),
      added_at: Date.now(),
      favorite: false,
      published_at: Date.now(),
      link: ""
    };
    return transition;
  }

  async getLegacySummary(pids: string[]): Promise<LegacyPodcast> {
    const defaults = await this.getLegacyDefaults();
    const title = pids.length ? `Summary: ${pids.length} Stories` : "Summary Podcast";
    const summary: LegacyPodcast = {
      id: `summary-${randomUUID()}`,
      title,
      show: "BriefCast",
      episode: "summary",
      duration: "3",
      duration_seconds: 180,
      listen_duration_seconds: 0,
      image_url: "image/summary.png",
      transcript_url: `transcript/${defaults.transcript}`,
      audio_url: `audio/${defaults.audio}`,
      category: "summary",
      subcategory: "summary",
      positive_rating: 0,
      negative_rating: 0,
      total_rating: 0,
      createAt: Date.now(),
      added_at: Date.now(),
      favorite: false,
      published_at: Date.now(),
      link: ""
    };
    this.legacyPodcastCache.set(summary.id, summary);
    return summary;
  }

  async getLegacyHistory(limit = 100): Promise<Array<Record<string, unknown>>> {
    const defaults = await this.getLegacyDefaults();
    const history = this.db.getHistory(limit);
    return history.map((entry) => ({
      id: entry.recommendationId,
      image_url: `image/${entry.imageResource || defaults.image}`,
      title: entry.title,
      subcategory: entry.subcategory,
      listen_duration_seconds: entry.progressSeconds,
      duration_seconds: entry.durationSeconds,
      stop_position_seconds: entry.progressSeconds,
      listened_at: entry.listenedAt,
      published_at: entry.listenedAt
    }));
  }

  async markLegacyPlaying(userId: string, podcastId: string, position: number): Promise<{ ok: boolean }> {
    this.legacyNowPlaying.set(userId, {
      podcastId,
      position: Number.isFinite(position) ? position : 0,
      updatedAt: Date.now()
    });
    return { ok: true };
  }

  async markLegacyPlayed(payload: Record<string, unknown>): Promise<{ ok: boolean }> {
    const podcastId = String(payload.podcast_id ?? "");
    if (!podcastId) {
      return { ok: false };
    }

    const progress = Number(payload.last_position ?? payload.listen_duration_seconds ?? 0);
    const duration = Number(payload.total_duration_seconds ?? 0);

    try {
      await this.trackHistory({
        recommendationId: podcastId,
        progressSeconds: Number.isFinite(progress) ? progress : 0,
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined
      });
    } catch {
      // Ignore non-recommendation podcast ids (e.g. summary/transition) in compatibility mode.
    }

    return { ok: true };
  }

  signupLegacy(userId: string, password: string, preference: Record<string, unknown>): { token: string } {
    return this.legacyState.signup(userId, password, preference);
  }

  signinLegacy(userId: string, password: string): { token: string } {
    return this.legacyState.signin(userId, password);
  }

  signoutLegacy(authHeader?: string): { ok: boolean } {
    return this.legacyState.signout(authHeader);
  }

  resolveLegacyUserId(authHeader?: string): string {
    return this.legacyState.resolveUserId(authHeader);
  }

  getLegacyUser(authHeader?: string): Record<string, unknown> {
    const userId = this.resolveLegacyUserId(authHeader);
    const user = this.legacyState.getUser(userId);
    const tokens = this.legacyState.getUserTokens(userId).map((entry) => entry.token);
    return {
      id: user.id,
      preference: user.preference,
      location: user.location,
      tokens
    };
  }

  getLegacyTokens(authHeader?: string): Array<Record<string, unknown>> {
    const userId = this.resolveLegacyUserId(authHeader);
    return this.legacyState.getUserTokens(userId).map((entry) => ({
      token: entry.token,
      device_type: entry.deviceType,
      created_at: entry.createdAt
    }));
  }

  issueLegacyToken(userId: string): Record<string, unknown> {
    const created = this.legacyState.issueToken(userId);
    return {
      token: created.token,
      device_type: created.deviceType,
      created_at: created.createdAt
    };
  }

  revokeLegacyToken(authHeader: string | undefined, userId: string, token: string): { ok: boolean } {
    const resolvedUser = userId || this.resolveLegacyUserId(authHeader);
    return this.legacyState.revokeToken(resolvedUser, token);
  }

  async getLegacyPlaylists(authHeader?: string): Promise<Array<Record<string, unknown>>> {
    const userId = this.resolveLegacyUserId(authHeader);
    const all = this.legacyState.listPlaylists(userId);
    return all.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      created_at: playlist.createdAt,
      podcasts: []
    }));
  }

  async getLegacyPlaylistItems(authHeader: string | undefined, playlistId: string): Promise<LegacyPodcast[]> {
    const userId = this.resolveLegacyUserId(authHeader);
    const playlist = this.legacyState.getPlaylist(userId, playlistId);
    if (!playlist) {
      return [];
    }

    const podcasts = await Promise.all(playlist.podcastIds.map((podcastId) => this.getLegacyPodcast(podcastId)));
    return podcasts.filter((item): item is LegacyPodcast => item !== null);
  }

  createLegacyPlaylist(authHeader: string | undefined, name: string, description = ""): { id: string } {
    const userId = this.resolveLegacyUserId(authHeader);
    const playlist = this.legacyState.createPlaylist(userId, name, description);
    return { id: playlist.id };
  }

  updateLegacyPlaylist(authHeader: string | undefined, playlistId: string, name: string, description = ""): { ok: boolean } {
    const userId = this.resolveLegacyUserId(authHeader);
    this.legacyState.updatePlaylist(userId, playlistId, name, description);
    return { ok: true };
  }

  removeLegacyPlaylist(authHeader: string | undefined, playlistId: string): { ok: boolean } {
    const userId = this.resolveLegacyUserId(authHeader);
    return this.legacyState.removePlaylist(userId, playlistId);
  }

  addLegacyPlaylistItem(authHeader: string | undefined, playlistId: string, podcastId: string): { ok: boolean } {
    const userId = this.resolveLegacyUserId(authHeader);
    return this.legacyState.addToPlaylist(userId, playlistId, podcastId);
  }

  removeLegacyPlaylistItem(authHeader: string | undefined, playlistId: string, podcastId: string): { ok: boolean } {
    const userId = this.resolveLegacyUserId(authHeader);
    return this.legacyState.removeFromPlaylist(userId, playlistId, podcastId);
  }

  getLegacyRssLinks(): LegacyRssLink[] {
    return this.legacyState.getRssLinks();
  }

  getLegacyRssLink(id: number): LegacyRssLink | null {
    return this.legacyState.getRssLink(id);
  }

  addLegacyRssLink(link: string, country: string, category: string): LegacyRssLink {
    return this.legacyState.addRssLink(link, country, category);
  }

  updateLegacyRssLink(id: number, link: string, country: string, category: string): LegacyRssLink {
    return this.legacyState.updateRssLink(id, link, country, category);
  }

  deleteLegacyRssLink(id: number): { ok: boolean } {
    return this.legacyState.deleteRssLink(id);
  }

  checkLegacyRssLink(id: number): LegacyRssLink {
    return this.legacyState.checkRssLink(id);
  }

  refreshLegacyRssLinks(): { ok: boolean; checked: number } {
    return this.legacyState.refreshRssLinks();
  }

  getLegacyConfig(): Record<string, string> {
    return this.legacyState.getEnvConfig();
  }

  setLegacyConfig(patch: Record<string, string>): Record<string, string> {
    return this.legacyState.setEnvConfig(patch);
  }

  getMediaManifest(): Promise<MediaManifest> {
    return this.mediaResources.getManifest();
  }

  readMediaResource(name: string, format: MediaResourceFormat = "base64"): Promise<MediaResourcePayload> {
    return this.mediaResources.readResource(name, format);
  }

  readMediaResourceBuffer(name: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
    return this.mediaResources.readResourceBuffer(name);
  }

  // ── User profile (single-user, no auth) ──────────────────────────────────

  getUserProfile(): UserProfile {
    return {
      id: "local",
      preference: {
        topics: this.settings.preferences.topics,
        region: this.settings.preferences.region,
        language: this.settings.preferences.language,
      },
    };
  }

  updateUserProfile(prefs: Partial<UserPreferenceSettings>): UserProfile {
    if (prefs.topics !== undefined) this.settings.preferences.topics = prefs.topics;
    if (prefs.region !== undefined) this.settings.preferences.region = prefs.region;
    if (prefs.language !== undefined) this.settings.preferences.language = prefs.language;
    this.configStore.save(this.settings);
    return this.getUserProfile();
  }

  // ── Trending ─────────────────────────────────────────────────────────────

  async getTrending(limit = 20): Promise<RecommendationPodcast[]> {
    const all = await this.getRecommendations(limit * 3);
    // Sort by publishedAt descending (newest = "trending")
    return all
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, limit);
  }

  // ── Playlists ────────────────────────────────────────────────────────────

  getPlaylists(): Promise<PlaylistInfo[]> {
    const userId = "local";
    return Promise.resolve(this.db.getPlaylistsByUser(userId));
  }

  createPlaylist(name: string, description = ""): PlaylistInfo {
    const userId = "local";
    return this.db.createPlaylist(userId, name, description);
  }

  deletePlaylist(playlistId: string): void {
    this.db.deletePlaylist(playlistId);
  }

  addToPlaylist(playlistId: string, podcastId: string): void {
    this.db.addToPlaylist(playlistId, podcastId);
  }

  removeFromPlaylist(playlistId: string, podcastId: string): void {
    this.db.removeFromPlaylist(playlistId, podcastId);
  }

  // ── Rating ────────────────────────────────────────────────────────────────

  ratePodcast(podcastId: string, rating: number): void {
    this.db.ratePodcast(podcastId, rating);
    const cached = this.podcastCache.get(podcastId);
    if (cached) {
      this.podcastCache.set(podcastId, { ...cached, rating });
    }
  }

  // ── Podcast audio generation ─────────────────────────────────────────────

  private recToPodcast(rec: RecommendationPodcast, imageUrl: string): Podcast {
    return {
      id: rec.id,
      title: rec.title,
      subcategory: rec.subcategory,
      source_name: rec.sourceName,
      image_url: imageUrl,
      audio_url: "",
      transcript_url: "",
      duration_seconds: rec.estimatedDurationSeconds,
      published_at: rec.publishedAt,
      link: rec.url,
      rating: 0,
    };
  }

  getPodcastById(podcastId: string): Podcast | null {
    return this.podcastCache.get(podcastId) ?? this.db.getPodcastById(podcastId);
  }

  async generatePodcastAudio(recommendationId: string): Promise<Podcast> {
    const cached = this.podcastCache.get(recommendationId);
    if (cached && cached.audio_url) return cached;

    const manifest = await this.mediaResources.getManifest();
    const imageResource = manifest.defaults.speakerImage || "default.png";
    const rec = this.db.getRecommendationById(recommendationId, imageResource);
    if (!rec) throw new Error(`Recommendation not found: ${recommendationId}`);

    const newsImagePath = path.join(manifest.resourceDir, "news.png");
    const imageUrl = rec.imageUrl ?? `file://${newsImagePath}`;

    // Generate via pipeline (single article)
    const pipeline = await generateDailyPodcast({
      baseDir: this.baseDir,
      resourceDir: manifest.resourceDir,
      settings: this.settings,
      articles: [{
        id: rec.id,
        title: rec.title,
        summary: rec.summary,
        sourceName: rec.sourceName,
        url: rec.url,
        publishedAt: rec.publishedAt,
      }],
      title: rec.title,
    });

    const podcast: Podcast = {
      id: recommendationId,
      title: rec.title,
      subcategory: rec.subcategory,
      source_name: rec.sourceName,
      image_url: imageUrl,
      audio_url: `file://${pipeline.audioPath}`,
      transcript_url: `file://${pipeline.lrcPath}`,
      duration_seconds: pipeline.durationSeconds,
      published_at: rec.publishedAt,
      link: rec.url,
      rating: 0,
    };

    this.db.savePodcast(podcast);
    this.podcastCache.set(recommendationId, podcast);
    return podcast;
  }

  private async audioFileExists(audioUrl: string): Promise<boolean> {
    const filePath = audioUrl.startsWith("file://") ? audioUrl.slice(7) : audioUrl;
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getDailyPodcast(): Promise<Podcast | null> {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `daily-${today}`;
    const existing = this.podcastCache.get(cacheKey) ?? this.db.getDailyPodcast(today);
    if (existing && existing.audio_url && await this.audioFileExists(existing.audio_url)) {
      console.log("[getDailyPodcast] returning cached daily podcast:", cacheKey);
      this.podcastCache.set(cacheKey, existing);
      return existing;
    }
    console.log("[getDailyPodcast] no valid cached podcast for", today, "— starting generation");
    return this.generateDailyPodcastInternal();
  }

  async generateSummaryPodcast(podcastIds: string[]): Promise<Podcast> {
    const recs: Array<{ id: string; title: string; summary: string; sourceName: string; url: string; publishedAt: number }> = [];

    for (const pid of podcastIds) {
      const manifest = await this.mediaResources.getManifest();
      const imageResource = manifest.defaults.speakerImage || "default.png";
      const rec = this.db.getRecommendationById(pid, imageResource);
      if (rec) {
        recs.push({ id: rec.id, title: rec.title, summary: rec.summary, sourceName: rec.sourceName, url: rec.url, publishedAt: rec.publishedAt });
      }
    }

    if (!recs.length) throw new Error("No valid articles found for summary");

    const summaryManifest = await this.mediaResources.getManifest();
    const summaryImagePath = path.join(summaryManifest.resourceDir, "summary.png");

    const pipeline = await generateDailyPodcast({
      baseDir: this.baseDir,
      resourceDir: summaryManifest.resourceDir,
      settings: this.settings,
      articles: recs,
      title: `Summary: ${recs.length} Stories`,
      isSummary: true,
    });

    const summaryId = `summary-${pipeline.id}`;
    const podcast: Podcast = {
      id: summaryId,
      title: pipeline.title,
      subcategory: "News Summary",
      source_name: "BriefCast",
      image_url: `file://${summaryImagePath}`,
      audio_url: `file://${pipeline.audioPath}`,
      transcript_url: `file://${pipeline.lrcPath}`,
      duration_seconds: pipeline.durationSeconds,
      published_at: pipeline.publishedAt,
      link: "",
      is_summary: true,
    };

    this.db.savePodcast(podcast);
    this.podcastCache.set(summaryId, podcast);
    return podcast;
  }

  async forceDailyPodcast(): Promise<Podcast | null> {
    // Clear the in-memory cache for today so getDailyPodcast() regenerates unconditionally
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `daily-${today}`;
    this.podcastCache.delete(cacheKey);
    this.dailyInFlight = false;
    this.currentDailyDateKey = "";
    return this.generateDailyPodcastInternal();
  }

  private async generateDailyPodcastInternal(): Promise<Podcast | null> {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `daily-${today}`;

    if (this.dailyInFlight && this.currentDailyDateKey === today) {
      console.log("[generateDailyPodcastInternal] generation already in flight");
      return null;
    }

    await this.ensureSeedNews();
    const recs = await this.getRecommendations(5);
    if (!recs.length) {
      console.warn("[generateDailyPodcastInternal] no recommendations — cannot generate");
      return null;
    }

    this.dailyInFlight = true;
    this.currentDailyDateKey = today;

    const manifest = await this.mediaResources.getManifest();
    const dailyImagePath = path.join(manifest.resourceDir, "daily.png");
    const coverImage = recs[0].imageUrl ?? `file://${dailyImagePath}`;
    const location = await getIpLocation();

    try {
      const pipeline = await generateDailyPodcast({
        baseDir: this.baseDir,
        resourceDir: manifest.resourceDir,
        settings: this.settings,
        location: location ?? undefined,
        articles: recs.map((r) => ({
          id: r.id,
          title: r.title,
          summary: r.summary,
          sourceName: r.sourceName,
          url: r.url,
          publishedAt: r.publishedAt,
        })),
      });

      const podcast: Podcast = {
        id: cacheKey,
        title: pipeline.title,
        subcategory: "Daily Briefing",
        source_name: "BriefCast",
        image_url: coverImage,
        audio_url: `file://${pipeline.audioPath}`,
        transcript_url: `file://${pipeline.lrcPath}`,
        duration_seconds: pipeline.durationSeconds,
        published_at: pipeline.publishedAt,
        link: "",
        is_daily: true,
      };

      this.db.savePodcast(podcast);
      this.podcastCache.set(cacheKey, podcast);
      return podcast;
    } finally {
      this.dailyInFlight = false;
    }
  }

  async cleanupOldPodcastFiles(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const podcasts = this.db.getAllPodcasts();
    for (const podcast of podcasts) {
      if (podcast.published_at < cutoff && podcast.audio_url) {
        const filePath = podcast.audio_url.startsWith("file://")
          ? podcast.audio_url.slice(7)
          : podcast.audio_url;
        try {
          await fs.unlink(filePath);
          console.log("[cleanup] deleted old audio:", filePath);
        } catch {
          // file already gone or inaccessible
        }
      }
    }
  }
}
