import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ConfigStore } from "./configStore";
import { BriefcastDb } from "./db";
import { LegacyStateService, LegacyRssLink } from "./legacyState";
import { MediaResourceService } from "./mediaResources";
import { dedupeArticles, enrichWithArticleImages, fetchDevTo, fetchGithubTrending, fetchGoogleNews, fetchHackerNews, fetchLobsters, fetchProductHunt, fetchReddit, fetchRssNews, fetchSlashdot, fetchTopHeadlines, IngestArticle } from "./newsSources";
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
  PreferenceActivityInput,
  RecommendationPodcast,
  SearchMode,
  SearchResult,
  SyncResult,
  UserPreferenceSettings,
  UserProfile
} from "../../shared/types";

/** Resolve device location as "lat,lon" string via IP geolocation with fallback services. */
async function getIpLocation(): Promise<string | null> {
  type GeoResponse = { latitude?: number; longitude?: number; lat?: number; lon?: number };

  const services: Array<{ url: string; parse: (d: GeoResponse) => [number, number] | null }> = [
    {
      url: "https://ipapi.co/json/",
      parse: (d) =>
        typeof d.latitude === "number" && typeof d.longitude === "number"
          ? [d.latitude, d.longitude]
          : null,
    },
    {
      url: "https://ip-api.com/json/?fields=lat,lon,status",
      parse: (d) =>
        typeof d.lat === "number" && typeof d.lon === "number" ? [d.lat, d.lon] : null,
    },
    {
      url: "https://ipwho.is/",
      parse: (d) =>
        typeof d.latitude === "number" && typeof d.longitude === "number"
          ? [d.latitude, d.longitude]
          : null,
    },
  ];

  for (const svc of services) {
    try {
      const res = await fetch(svc.url, {
        headers: { "User-Agent": "BriefCast/1.0" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.warn(`[getIpLocation] ${svc.url} returned ${res.status}`);
        continue;
      }
      const data = (await res.json()) as GeoResponse;
      const coords = svc.parse(data);
      if (coords) {
        console.log(`[getIpLocation] resolved via ${svc.url}: ${coords[0].toFixed(2)},${coords[1].toFixed(2)}`);
        return `${coords[0].toFixed(2)},${coords[1].toFixed(2)}`;
      }
      console.warn(`[getIpLocation] ${svc.url} returned no coords:`, JSON.stringify(data).slice(0, 120));
    } catch (err) {
      console.warn(`[getIpLocation] ${svc.url} failed:`, err);
    }
  }

  console.warn("[getIpLocation] all geolocation services failed — weather will be skipped");
  return null;
}

function dateKeyNow(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function clip(text: string, max = 1600): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

const NEWS_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const NEWS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const GLOBAL_HOT_NEWS_COUNT = 3;

function freshCutoff(now = Date.now()): number {
  return now - NEWS_FRESHNESS_MS;
}

function isFreshArticle(article: { publishedAt: number }, now = Date.now()): boolean {
  return Number.isFinite(article.publishedAt) && article.publishedAt >= freshCutoff(now);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function looksLikeGlobalHotNews(article: { title: string; summary?: string; content?: string; sourceName?: string }): boolean {
  const text = `${article.title} ${article.summary ?? ""} ${article.content ?? ""} ${article.sourceName ?? ""}`.toLowerCase();
  return /\b(economy|economic|inflation|central bank|federal reserve|fed|interest rate|tariff|trade|market|markets|stock|stocks|bond|bonds|oil|currency|dollar|euro|yuan|earnings|finance|financial|bank|banking|election|government|minister|president|congress|senate|parliament|policy|geopolitic|war|ceasefire|sanction|ukraine|russia|china|taiwan|middle east|israel|gaza|iran|nato|united nations|global)\b/.test(text);
}

function compareByFreshnessThenPublished<T extends { publishedAt: number }>(a: T, b: T): number {
  const freshDelta = Number(isFreshArticle(b)) - Number(isFreshArticle(a));
  return freshDelta || b.publishedAt - a.publishedAt;
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
  text?: string;
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
  private readonly legacyTransitionInFlight: Map<string, Promise<LegacyPodcast>>;
  private readonly podcastGenerationInFlight: Map<string, Promise<Podcast>>;
  private podcastGenerationQueue: Promise<void> = Promise.resolve();
  private settings: AppSettings;
  // Write-through in-memory cache backed by SQLite
  private readonly podcastCache: Map<string, Podcast>;
  private readonly baseDir: string;
  // Shared promise so concurrent ensureSeedNews callers wait for the same sync
  private seedNewsPromise: Promise<void> | null = null;
  // Single in-flight promise for daily podcast — guarantees at most one generation runs
  private _dailyPodcastPromise: Promise<Podcast | null> | null = null;
  private _dailyPodcastDateKey: string = "";
  private preferenceActivityCounter = 0;
  // Cache for top headlines (15-min TTL) — avoids re-fetching on every trending call
  private _trendingCache: { ts: number; items: RecommendationPodcast[] } = { ts: 0, items: [] };
  private static readonly TRENDING_TTL_MS = 15 * 60 * 1000;
  // Cached city resolved once from IP geolocation (null = unknown or failed)
  private _ipCityPromise: Promise<string | null> | null = null;

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
    this.legacyTransitionInFlight = new Map();
    this.podcastGenerationInFlight = new Map();
    this.settings = this.configStore.load();
    this.podcastCache = new Map();
    this.baseDir = baseDir;
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  saveSettings(input: AppSettings): AppSettings {
    this.settings = this.configStore.save(input);
    return this.settings;
  }

  /** Returns the epoch ms of the last completed news sync (0 if never). */
  getLastSyncTime(): number {
    const val = this.legacyState.getEnvConfig()["lastNewsSyncAt"];
    return val ? parseInt(val, 10) || 0 : 0;
  }

  /** Stamps the current time as the last completed sync. */
  private markSyncTime(): void {
    this.legacyState.setEnvConfig({ lastNewsSyncAt: String(Date.now()) });
  }


  /** Keep recommendation/daily selection grounded in recently fetched news. */
  private async ensureFreshNews(maxAgeMs = NEWS_REFRESH_INTERVAL_MS): Promise<void> {
    const lastSync = this.getLastSyncTime();
    const hasFresh = this.db.recentArticles(100).some((item) => isFreshArticle(item));
    if (!lastSync || Date.now() - lastSync > maxAgeMs || !hasFresh) {
      console.log("[fresh-news] refreshing news before selection — lastSync:", lastSync || "never", "hasFresh:", hasFresh);
      try {
        await this.syncNews();
      } catch (err) {
        console.warn("[fresh-news] sync failed; continuing with cached fresh articles if any:", err instanceof Error ? err.message : err);
      }
    }
  }

  private async recommendationImageResource(): Promise<string> {
    try {
      const manifest = await this.mediaResources.getManifest();
      return manifest.defaults.speakerImage || "default.png";
    } catch (err) {
      console.warn("[recommendations] failed to load media manifest, using default image:", err instanceof Error ? err.message : err);
      return "default.png";
    }
  }

  private async ingestLiveHeadlines(limit: number): Promise<void> {
    const embeddingModel =
      this.settings.providers.activeProvider === "openai-compatible"
        ? this.settings.providers.openaiCompatible.embeddingModel || "local-hash-v1"
        : "local-hash-v1";

    const headlines = await fetchTopHeadlines(limit);
    const freshHeadlines = headlines.filter((h) => isFreshArticle(h));
    for (const headline of freshHeadlines) {
      if (this.db.articleExistsByUrl(headline.url)) continue;
      const searchable = `${headline.title}\n${headline.summary}\n${headline.content}`.trim();
      if (searchable.length < 12) continue;
      const vector = await embedText(this.settings, searchable);
      this.db.upsertArticle(headline, vector, embeddingModel);
    }
  }

  private async getGlobalHotNews(limit = GLOBAL_HOT_NEWS_COUNT): Promise<RecommendationPodcast[]> {
    const imageResource = await this.recommendationImageResource();
    const historySeen = new Set(this.db.getHistory(600).map((item) => item.recommendationId));

    try {
      await Promise.race([
        this.ingestLiveHeadlines(Math.max(30, limit * 12)),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("headline ingest timeout")), 10000))
      ]);
    } catch (err) {
      console.warn("[daily-hot-news] live headline ingest unavailable:", err instanceof Error ? err.message : err);
    }

    const freshRecent = this.db
      .getRecommendations(120, imageResource)
      .filter((item) => isFreshArticle(item) && !historySeen.has(item.id));

    const hot = freshRecent.filter(looksLikeGlobalHotNews);
    const selected = (hot.length ? hot : freshRecent)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, limit);

    console.log(`[daily-hot-news] selected ${selected.length}/${limit} fresh global lead stories`);
    return selected;
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
      const sixHoursMs = 6 * 60 * 60 * 1000;
      const feedsToFetch = rssFeeds.filter((feed) => this.legacyState.shouldCheckRssFeed(feed, sixHoursMs));
      console.log("[syncNews] fetching RSS from", feedsToFetch.length, "/", rssFeeds.length, "feeds…");
      if (!feedsToFetch.length) {
        console.log("[syncNews] RSS skipped (all feeds checked within last 6 hours)");
      } else {
      try {
          const rss = await fetchRssNews(feedsToFetch, 30);
        console.log("[syncNews] RSS returned", rss.length, "articles");
        all.push(...rss);
      } catch (error) {
        sourceErrors.push(`rss:${error instanceof Error ? error.message : String(error)}`);
        console.error("[syncNews] RSS error:", error);
      } finally {
          for (const feed of feedsToFetch) {
            this.legacyState.markRssFeedChecked(feed);
          }
        }
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

    // Always add broad front-page headlines so daily briefings can lead with global political/economic/financial news,
    // not only sources implied by the user's preference profile.
    try {
      const headlines = await fetchTopHeadlines(30);
      console.log("[syncNews] Top headlines returned", headlines.length, "articles");
      all.push(...headlines);
    } catch (error) {
      sourceErrors.push(`top-headlines:${error instanceof Error ? error.message : String(error)}`);
      console.error("[syncNews] Top headlines error:", error);
    }

    const deduped = dedupeArticles(all);
    console.log("[syncNews] total fetched:", all.length, "after dedup:", deduped.length);
    const freshDeduped = deduped.filter((article) => isFreshArticle(article));
    console.log("[syncNews] fresh within 24h:", freshDeduped.length, "stale skipped before ingest:", deduped.length - freshDeduped.length);

    // Scrape og:image from article pages for any fresh articles missing an image
    await enrichWithArticleImages(freshDeduped);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let imagesUpdated = 0;

    const embeddingModel =
      this.settings.providers.activeProvider === "openai-compatible"
        ? this.settings.providers.openaiCompatible.embeddingModel || "local-hash-v1"
        : "local-hash-v1";

    for (const article of freshDeduped) {
      // Check if article already exists
      if (this.db.articleExistsByUrl(article.url)) {
        // Even for existing articles, update image if we have one and they don't
        if (article.imageUrl && this.db.updateArticleImageIfMissing(article.url, article.imageUrl)) {
          imagesUpdated += 1;
        }
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
    console.log(`[syncNews] done — inserted:${inserted} updated:${updated} skipped:${skipped} images_backfilled:${imagesUpdated}`);
    this.markSyncTime();

    return {
      fetched: freshDeduped.length,
      inserted,
      updated,
      skipped
    };
  }

  /**
   * Backfill images for existing articles that don't have one.
   * Scrapes article pages to extract og:image. Runs in batches to avoid overloading.
   */
  async backfillMissingImages(batchSize = 50): Promise<number> {
    const missing = this.db.getArticlesMissingImages(batchSize);
    if (!missing.length) {
      console.log("[backfillImages] no articles missing images");
      return 0;
    }

    console.log(`[backfillImages] enriching ${missing.length} articles without images`);

    // Build fake IngestArticle objects for the enrichment function
    const toEnrich: IngestArticle[] = missing.map((row) => ({
      title: "",
      url: row.url,
      sourceType: "rss" as const,
      sourceName: "",
      summary: "",
      content: "",
      publishedAt: 0,
      imageUrl: undefined,
    }));

    await enrichWithArticleImages(toEnrich);

    let updated = 0;
    for (const article of toEnrich) {
      if (article.imageUrl && this.db.updateArticleImageIfMissing(article.url, article.imageUrl)) {
        updated += 1;
      }
    }

    console.log(`[backfillImages] updated ${updated}/${missing.length} articles with images`);
    return updated;
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
    await this.ensureFreshNews();
    const topics = this.settings.preferences.topics.filter(Boolean);
    console.log("[briefing] starting — provider:", this.settings.providers.activeProvider, "topics:", topics);

    const gathered = new Map<string, SearchResult>();
    const hotBriefingNews = await this.getGlobalHotNews(GLOBAL_HOT_NEWS_COUNT);
    const hotBriefingIds = new Set(hotBriefingNews.map((item) => item.id));
    for (const item of hotBriefingNews) {
      gathered.set(item.id, {
        id: item.id,
        title: item.title,
        url: item.url,
        sourceType: item.sourceType,
        sourceName: item.sourceName,
        summary: item.summary,
        content: item.summary,
        publishedAt: item.publishedAt,
        imageUrl: item.imageUrl,
      });
    }

    if (topics.length) {
      for (const topic of topics) {
        console.log("[briefing] embedding topic:", topic);
        const queryVector = await embedText(this.settings, topic);
        const matches = this.db.hybridSearch(topic, queryVector, 16).filter((item) => isFreshArticle(item)).slice(0, 8);
        console.log(`[briefing] topic "${topic}" → ${matches.length} articles`);
        for (const item of matches) {
          gathered.set(item.id, item);
        }
      }
    }

    if (!gathered.size) {
      console.log("[briefing] no topic matches — falling back to recent articles");
      for (const item of this.db.recentArticles(40).filter((article) => isFreshArticle(article)).slice(0, 20)) {
        gathered.set(item.id, item);
      }
    }

    const articlesUsed = [...gathered.values()]
      .sort((a, b) => {
        const hotDelta = Number(hotBriefingIds.has(b.id)) - Number(hotBriefingIds.has(a.id));
        return hotDelta || b.publishedAt - a.publishedAt;
      })
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

  /** Resolve the user's city from IP geolocation (cached for the service lifetime). */
  private getIpCity(): Promise<string | null> {
    if (!this._ipCityPromise) {
      this._ipCityPromise = (async () => {
        try {
          const res = await fetch("https://ipapi.co/json/", {
            headers: { "User-Agent": "BriefCast/1.0" },
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return null;
          const data = (await res.json()) as { city?: string; region?: string; country_name?: string };
          const city = data.city || null;
          const country = data.country_name || null;
          if (city && country) return `${city}, ${country}`;
          return city || country || null;
        } catch {
          return null;
        }
      })();
    }
    return this._ipCityPromise;
  }

  /**
   * Build a rich natural-language preference description by asking the LLM.
   * Blends manual topic settings with behavioral signals (listen completion + ratings).
   * Falls back to a template string if the LLM call fails or isn't configured.
   */
  private async buildPreferenceDescription(): Promise<string> {
    const { topics, region, language } = this.settings.preferences;
    const topicList = topics.filter(Boolean).join(", ") || "general news";
    const selectedTopicHint = topics.length
      ? `Selected topic and subtopic signals: ${topics.filter(Boolean).join(", ")}.`
      : "";
    const behaviorSummary = this.buildBehavioralSignalSummary();

    // Resolve city in parallel — best-effort; don't block if it fails
    const city = await Promise.race([
      this.getIpCity(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
    ]);

    // Template fallback (used when LLM unavailable)
    const localHint = city ? ` Include some local news from ${city}.` : "";
    const fallback = `News articles about ${topicList} relevant to a reader in ${region || "the US"} who prefers content in ${language || "English"}.${localHint} Focus on recent developments, analysis, and key events.`;

    try {
      const promptLines = [
        "You are helping a personalized news podcast app select relevant articles for a user.",
        "Write a 2-3 sentence description of what this user wants to read, for use as a semantic search query.",
        "Be specific about topics, tone, and recency. Output only the description text, no labels.",
        "",
        `User preferences:`,
        `  Topics of interest: ${topicList}`,
        ...(selectedTopicHint ? [`  ${selectedTopicHint}`] : []),
        `  Region: ${region || "US"}`,
        `  Language: ${language || "English"}`,
        ...(city
          ? [`  User's city: ${city} — blend in some city-level local news for this location. World news, national news, and technology news are NOT filtered by city.`]
          : []),
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
    try {
      await Promise.race([
        this.ensureFreshNews(),
        new Promise<void>((resolve) => setTimeout(resolve, 10000))
      ]);
    } catch (err) {
      console.warn("[getRecommendations] fresh news sync failed/timed out:", err instanceof Error ? err.message : err);
    }

    const imageResource = await this.recommendationImageResource();

    // Exclude items already in trending cache to avoid duplication
    const trendingIds = new Set(this._trendingCache.items.map((t) => t.id));

    const historySeen = new Set(this.db.getHistory(600).map((item) => item.recommendationId));
    const fallbackCandidates = this.db
      .getRecommendations(Math.max(limit * 4, 160), imageResource)
      .filter((item) => !historySeen.has(item.id) && !trendingIds.has(item.id))
      .sort(compareByFreshnessThenPublished)
      .slice(0, limit);

    try {
      // Bound personalization latency so endpoint stays responsive.
      // Increased timeouts to allow LLM calls to complete (was 3s/5s, now 10s/15s)
      const preferenceDescription = await Promise.race<string>([
        this.buildPreferenceDescription(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("preference description timeout")), 10000))
      ]);
      console.log("[getRecommendations] running preference search with description length:", preferenceDescription.length);

      const semanticResults = await Promise.race<SearchResult[]>([
        this.preferenceSearch(preferenceDescription, Math.max(limit * 2, 200)),
        new Promise<SearchResult[]>((_, reject) => setTimeout(() => reject(new Error("preference search timeout")), 15000))
      ]);
      console.log("[getRecommendations] preference search returned:", semanticResults.length, "results");

      if (semanticResults.length) {
        const filtered = semanticResults
          .filter((r) => !historySeen.has(r.id) && !trendingIds.has(r.id))
          .sort((a, b) => {
            const freshDelta = Number(isFreshArticle(b)) - Number(isFreshArticle(a));
            return freshDelta || (b.semanticScore ?? b.hybridScore ?? 0) - (a.semanticScore ?? a.hybridScore ?? 0) || b.publishedAt - a.publishedAt;
          })
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
    } catch (err) {
      console.warn("[getRecommendations] personalized ranking unavailable, using fallback:", err instanceof Error ? err.message : err);
    }

    console.log("[getRecommendations] fallback candidates from DB:", fallbackCandidates.length);
    if (!fallbackCandidates.length) {
      console.warn("[getRecommendations] no articles in DB — library will be empty");
      return [];
    }
    return fallbackCandidates;
  }

  getHistory(limit = 200): ListenHistoryItem[] {
    const raw = this.db.getHistory(Math.max(limit * 5, limit));
    const seen = new Set<string>();
    const cleaned: ListenHistoryItem[] = [];

    for (const entry of raw) {
      const recId = String(entry.recommendationId ?? "").trim();
      const title = String(entry.title ?? "").trim();
      if (!recId || !title) continue;
      if (seen.has(recId)) continue;
      seen.add(recId);
      cleaned.push(entry);
      if (cleaned.length >= limit) break;
    }

    return cleaned;
  }

  async trackHistory(input: HistoryTrackInput): Promise<ListenHistoryItem> {
    const manifest = await this.mediaResources.getManifest();
    const imageResource = manifest.defaults.speakerImage || "default.png";
    return this.db.trackHistory(input, imageResource);
  }

  async trackPreferenceActivity(input: PreferenceActivityInput): Promise<{ ok: boolean; tracked?: ListenHistoryItem }> {
    const recommendationId = String(input.podcast_id ?? "").trim();
    if (!recommendationId) {
      return { ok: false };
    }

    const progressSeconds = Number(input.last_position ?? input.listen_duration_seconds ?? 0);
    const durationSeconds = Number(input.total_duration_seconds ?? 0);
    const tracked = await this.trackHistory({
      recommendationId,
      progressSeconds: Number.isFinite(progressSeconds) ? progressSeconds : 0,
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : undefined
    });

    const actions = Array.isArray(input.actions) ? input.actions : [];
    const hasLike = actions.some((a) => a.action === "like");
    const hasDislike = actions.some((a) => a.action === "dislike");
    if (hasLike && !hasDislike) {
      this.ratePodcast(recommendationId, 1);
    } else if (hasDislike && !hasLike) {
      this.ratePodcast(recommendationId, -1);
    }

    // Keep this lightweight on every play event; refresh topics periodically.
    this.preferenceActivityCounter += 1;
    if (this.preferenceActivityCounter % 5 === 0) {
      void this.refreshTopicsFromBehavior();
    }

    return { ok: true, tracked };
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

  private toLrc(transcript: string, estimatedDurationSecs?: number): string {
    const chunks = transcript
      .split(/(?<=[.!?])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!chunks.length) return "";

    if (estimatedDurationSecs && estimatedDurationSecs > 0) {
      // Distribute timestamps proportionally by word count so LRC tracks actual audio speed
      const wordCounts = chunks.map((c) => c.split(/\s+/).filter(Boolean).length);
      const totalWords = wordCounts.reduce((a, b) => a + b, 0);
      if (totalWords === 0) return "";

      let cursor = 0;
      return chunks
        .map((line, i) => {
          const min = Math.floor(cursor / 60).toString().padStart(2, "0");
          const secWhole = Math.floor(cursor % 60).toString().padStart(2, "0");
          const secFrac = Math.round((cursor % 1) * 100).toString().padStart(2, "0");
          const ts = `[${min}:${secWhole}.${secFrac}]`;
          cursor += (wordCounts[i] / totalWords) * estimatedDurationSecs;
          return `${ts}${line}`;
        })
        .join("\n");
    }

    // Fallback: estimate at ~3 words/sec (OpenAI nova TTS speed)
    let cursor = 0;
    return chunks
      .map((line) => {
        const min = Math.floor(cursor / 60).toString().padStart(2, "0");
        const sec = Math.floor(cursor % 60).toString().padStart(2, "0");
        const wordCount = line.split(/\s+/).filter(Boolean).length;
        cursor += Math.max(1.5, wordCount / 3.0);
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
    const audio = await synthesizeSpeech(this.settings, transcript);
    const actualDurationSecs = Math.max(2, (audio.buffer.byteLength * 8) / 128000);
    const lrc = this.toLrc(transcript, actualDurationSecs);

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
    favorite = false,
    includeMediaUrls = false // if false, return empty URLs so frontend knows to poll
  ): LegacyPodcast {
    const isDailyBriefing = recommendation.id.startsWith("daily-");
    const coverImage =
      isDailyBriefing
        ? "/image/daily.png"
        : recommendation.imageUrl && recommendation.imageUrl.trim()
        ? recommendation.imageUrl
        : `/image/${recommendation.imageResource || defaults.image || "default.png"}`;

    return {
      id: recommendation.id,
      title: recommendation.title,
      show: recommendation.sourceName,
      episode: recommendation.sourceType,
      duration: this.formatLegacyDuration(recommendation.estimatedDurationSeconds),
      duration_seconds: recommendation.estimatedDurationSeconds,
      listen_duration_seconds: Math.max(0, Math.floor(listenDuration)),
      image_url: coverImage,
      transcript_url: includeMediaUrls ? `/transcript/${defaults.transcript}` : "",
      audio_url: includeMediaUrls ? `/audio/${defaults.audio}` : "",
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

  // Convert any stored URL form → /kind/basename (safe to serve over HTTP)
  private normalizeMediaUrl(url: string, kind: "audio" | "transcript" | "image"): string {
    if (!url || url.trim() === "") return url;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    if (url.startsWith("file://")) return `/${kind}/${path.basename(url.slice(7))}`;
    if (url.startsWith(`/${kind}/`)) return url;
    if (url.startsWith(`${kind}/`)) return `/${url}`;
    if (!url.includes("/")) return `/${kind}/${url}`;
    return url;
  }

  // Resolve any URL form to a local filesystem path for existence / deletion checks
  private mediaUrlToFilePath(url: string): string {
    if (url.startsWith("file://")) return url.slice(7);
    if (/^\/(audio|transcript|image)\//.test(url)) return path.join(this.baseDir, url.slice(1));
    if (path.isAbsolute(url)) return url;
    return path.join(this.baseDir, url);
  }

  private toLegacyPodcastFromStored(podcast: Podcast): LegacyPodcast {
    return {
      id: podcast.id,
      title: podcast.title,
      show: podcast.source_name || "BriefCast",
      episode: podcast.subcategory || "episode",
      duration: this.formatLegacyDuration(podcast.duration_seconds),
      duration_seconds: podcast.duration_seconds,
      listen_duration_seconds: 0,
      image_url: this.normalizeMediaUrl(podcast.image_url || "/image/default.png", "image"),
      transcript_url: this.normalizeMediaUrl(podcast.transcript_url || "", "transcript"),
      audio_url: this.normalizeMediaUrl(podcast.audio_url || "", "audio"),
      category: podcast.subcategory || "general",
      subcategory: podcast.subcategory || "general",
      positive_rating: 0,
      negative_rating: 0,
      total_rating: podcast.rating ?? 0,
      createAt: podcast.published_at,
      added_at: podcast.published_at,
      favorite: false,
      published_at: podcast.published_at,
      link: podcast.link || ""
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
    const defaults = await this.getLegacyDefaults();
    const trending = await this.getTrending(limit);
    return trending.map((item) => this.buildLegacyPodcastFromRecommendation(item, defaults));
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
          imageResource: defaults.image,
          imageUrl: item.imageUrl,
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
    if (cached && cached.audio_url && cached.transcript_url) {
      return cached;
    }

    // Daily episodes are keyed as daily-YYYY-MM-DD and may need lazy generation.
    if (podcastId.startsWith("daily-")) {
      const todayKey = dateKeyNow();
      const requestedDateKey = podcastId.slice("daily-".length);

      // Only auto-generate today's daily podcast on demand.
      if (requestedDateKey === todayKey) {
        const daily = await this.generateLegacyPodcast(undefined, false);
        if (daily && daily.id === podcastId) {
          return daily;
        }
      }

      // Historical (or not-yet-generated) daily ids: return from cache if present.
      return this.legacyPodcastCache.get(podcastId) ?? null;
    }

    // If already generated before, return persisted media URLs immediately.
    const stored = this.getPodcastById(podcastId);
    if (stored && stored.audio_url && stored.transcript_url) {
      const legacy = this.toLegacyPodcastFromStored(stored);
      this.legacyPodcastCache.set(podcastId, legacy);
      return legacy;
    }

    const defaults = await this.getLegacyDefaults();
    const recommendation = this.db.getRecommendationById(podcastId, defaults.image);
    if (!recommendation) {
      return null;
    }

    // Return metadata immediately (audio_url/transcript_url empty) so the client can
    // display the article card while generation runs in the background — matches Python
    // backend behavior where /podcast/<id> always returns the current state of the record.
    const placeholder = this.buildLegacyPodcastFromRecommendation(recommendation, defaults);

    // Kick off audio generation once; client polls until audio_url is populated.
    void this.generatePodcastAudio(podcastId)
      .then((generated) => {
        if (generated.audio_url && generated.transcript_url) {
          this.legacyPodcastCache.set(podcastId, this.toLegacyPodcastFromStored(generated));
        }
      })
      .catch((err) => {
        console.error("[getLegacyPodcast] generation failed:", err);
      });

    return placeholder;
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
      image_url: "/image/daily.png",
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
          const storyCount = Math.max(1, Math.min(20, Math.floor(this.settings.preferences.dailyBriefingCount || 5)));
          const recommendations = await this.getRecommendations(storyCount);
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
            image_url: "/image/daily.png",
            transcript_url: `/transcript/${defaults.transcript}`,
            audio_url: `/audio/${defaults.audio}`,
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
    console.log("[transition] getLegacyTransition called:", { id1, id2 });
    const key = `${id1}:${id2}`;
    const inFlight = this.legacyTransitionInFlight.get(key);
    if (inFlight) {
      console.log("[transition] returning in-flight request");
      return inFlight;
    }

    const run = this.buildLegacyTransitionPodcast(id1, id2)
      .then((result) => {
        console.log("[transition] built transition podcast:", { id: result.id, audio_url: result.audio_url });
        return result;
      })
      .finally(() => {
        this.legacyTransitionInFlight.delete(key);
      });
    this.legacyTransitionInFlight.set(key, run);
    return run;
  }

  private async buildLegacyTransitionPodcast(id1: string, id2: string): Promise<LegacyPodcast> {
    const defaults = await this.getLegacyDefaults();
    const transitionHash = createHash("sha1").update(`${id1}:${id2}`).digest("hex").slice(0, 16);
    const transcriptFileName = `transition-${transitionHash}.lrc`;
    const audioFileName = `transition-${transitionHash}.mp3`;
    const transcriptPath = path.join(this.baseDir, "transcript", transcriptFileName);
    const audioPath = path.join(this.baseDir, "audio", audioFileName);

    await Promise.all([
      fs.mkdir(path.dirname(transcriptPath), { recursive: true }),
      fs.mkdir(path.dirname(audioPath), { recursive: true })
    ]);

    const imageResource = "host.png";
    const rec1 = this.db.getRecommendationById(id1, defaults.image);
    const rec2 = this.db.getRecommendationById(id2, defaults.image);
    const fromTitle = rec1?.title || "our previous story";
    const toTitle = rec2?.title || "our next update";
    const fromSummary = rec1?.summary || "";
    const toSummary = rec2?.summary || "";

    let transitionText = "";
    try {
      transitionText = await generateText(
        this.settings,
        [
          "Write ONLY one short spoken transition that links two news stories.",
          "Constraints: natural host voice, under 30 words, no labels, no markdown.",
          `Story 1 title: ${fromTitle}`,
          `Story 1 context: ${fromSummary}`,
          `Story 2 title: ${toTitle}`,
          `Story 2 context: ${toSummary}`
        ].join("\n")
      );
    } catch {
      transitionText = "";
    }

    if (!transitionText.trim()) {
      transitionText = `From ${fromTitle}, let's move to ${toTitle}.`;
    }
    const cleaned = transitionText.replace(/\s+/g, " ").trim();

    let durationSeconds = 12;
    const existingAudio = await this.audioFileExists(audioPath);
    const existingTranscript = await this.audioFileExists(transcriptPath);
    if (!existingAudio || !existingTranscript) {
      // Use "nova" (female) voice for host transitions by default
      const hostVoice = this.settings.tts.hostVoice || "nova";
      const speech = await synthesizeSpeech(this.settings, cleaned, hostVoice);
      await fs.writeFile(audioPath, speech.buffer);
      // Estimate real audio duration from MP3 bytes at 128 kbps
      const estimatedSecs = Math.max(2, (speech.buffer.byteLength * 8) / 128000);
      durationSeconds = Math.round(estimatedSecs);
      const lrc = this.toLrc(cleaned, estimatedSecs);
      await fs.writeFile(transcriptPath, lrc, "utf8");
    }

    const transition: LegacyPodcast = {
      id: `transition-${transitionHash}`,
      title: "Sofia Lane",
      show: "BriefCast",
      episode: `${id1}-${id2}`,
      duration: this.formatLegacyDuration(durationSeconds),
      duration_seconds: durationSeconds,
      listen_duration_seconds: 0,
      image_url: `/image/${imageResource}`,
      transcript_url: `/transcript/${transcriptFileName}`,
      audio_url: `/audio/${audioFileName}`,
      category: "transition",
      subcategory: "transition",
      positive_rating: 0,
      negative_rating: 0,
      total_rating: 0,
      createAt: Date.now(),
      added_at: Date.now(),
      favorite: false,
      published_at: Date.now(),
      link: "",
      text: cleaned
    };
    return transition;
  }

  async readLegacyAssetBuffer(kind: "image" | "audio" | "transcript", fileName: string): Promise<{ mimeType: string; buffer: Buffer }> {
    const cleaned = path.basename(fileName);
    if (!cleaned) {
      throw new Error("Invalid file name");
    }
    if (kind === "image") {
      const resource = await this.readMediaResourceBuffer(cleaned);
      return { mimeType: resource.mimeType, buffer: resource.buffer };
    }

    const fullPath = path.join(this.baseDir, kind, cleaned);
    try {
      const buffer = await fs.readFile(fullPath);
      const ext = path.extname(cleaned).toLowerCase();
      const mimeType =
        kind === "audio"
          ? (ext === ".wav" ? "audio/wav" : ext === ".ogg" ? "audio/ogg" : "audio/mpeg")
          : "text/plain; charset=utf-8";
      return { mimeType, buffer };
    } catch {
      const resource = await this.readMediaResourceBuffer(cleaned);
      return { mimeType: resource.mimeType, buffer: resource.buffer };
    }
  }

  async getLegacySummary(pids: string[]): Promise<LegacyPodcast> {
    const defaults = await this.getLegacyDefaults();
    const title = pids.length ? `Summary: ${pids.length} Stories` : "Summary Podcast";

    try {
      const generated = await this.generateSummaryPodcast(pids);
      const summary: LegacyPodcast = {
        id: generated.id,
        title: generated.title || title,
        show: "BriefCast",
        episode: "summary",
        duration: this.formatLegacyDuration(generated.duration_seconds || 180),
        duration_seconds: generated.duration_seconds || 180,
        listen_duration_seconds: 0,
        image_url: "/image/summary.png",
        transcript_url: this.normalizeMediaUrl(generated.transcript_url || `/transcript/${defaults.transcript}`, "transcript"),
        audio_url: this.normalizeMediaUrl(generated.audio_url || `/audio/${defaults.audio}`, "audio"),
        category: "summary",
        subcategory: "summary",
        positive_rating: 0,
        negative_rating: 0,
        total_rating: 0,
        createAt: Date.now(),
        added_at: Date.now(),
        favorite: false,
        published_at: generated.published_at || Date.now(),
        link: ""
      };
      this.legacyPodcastCache.set(summary.id, summary);
      return summary;
    } catch {
      const summary: LegacyPodcast = {
        id: `summary-${randomUUID()}`,
        title,
        show: "BriefCast",
        episode: "summary",
        duration: "3",
        duration_seconds: 180,
        listen_duration_seconds: 0,
        image_url: "/image/summary.png",
        transcript_url: `/transcript/${defaults.transcript}`,
        audio_url: `/audio/${defaults.audio}`,
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
  }

  async getLegacyHistory(limit = 100): Promise<Array<Record<string, unknown>>> {
    const defaults = await this.getLegacyDefaults();
    const history = this.getHistory(limit);
    return history.map((entry) => ({
      id: entry.id,
      recommendation_id: entry.recommendationId,
      image_url: String(entry.recommendationId).startsWith("daily-")
        ? "/image/daily.png"
        : entry.imageUrl && entry.imageUrl.trim()
          ? entry.imageUrl
          : `/image/${entry.imageResource || defaults.image}`,
      title: entry.title,
      subcategory: entry.subcategory,
      listen_duration_seconds: entry.progressSeconds,
      duration_seconds: entry.durationSeconds,
      stop_position_seconds: entry.progressSeconds,
      listened_at: entry.listenedAt,
      published_at: entry.publishedAt || entry.listenedAt
    }));
  }

  async markLegacyPlaying(userId: string, podcastId: string, position: number): Promise<{ ok: boolean }> {
    this.legacyNowPlaying.set(userId, {
      podcastId,
      position: Number.isFinite(position) ? position : 0,
      updatedAt: Date.now()
    });
    if (podcastId) {
      try {
        const resolvedPosition = Number.isFinite(position) ? Math.max(0, Math.floor(position)) : 0;
        const podcast = this.getPodcastById(podcastId);
        await this.trackHistory({
          recommendationId: podcastId,
          progressSeconds: resolvedPosition,
          durationSeconds: podcast?.duration_seconds
        });
      } catch {
        // Keep /playing lightweight and never fail caller because history write failed.
      }
    }
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
        dailyBriefingCount: this.settings.preferences.dailyBriefingCount,
      },
    };
  }

  updateUserProfile(prefs: Partial<UserPreferenceSettings>): UserProfile {
    if (prefs.topics !== undefined) this.settings.preferences.topics = prefs.topics;
    if (prefs.region !== undefined) this.settings.preferences.region = prefs.region;
    if (prefs.language !== undefined) this.settings.preferences.language = prefs.language;
    if (prefs.dailyBriefingCount !== undefined) {
      const n = Number(prefs.dailyBriefingCount);
      if (Number.isFinite(n)) {
        this.settings.preferences.dailyBriefingCount = Math.max(1, Math.min(20, Math.floor(n)));
      }
    }
    this.configStore.save(this.settings);
    return this.getUserProfile();
  }

  // ── Trending ─────────────────────────────────────────────────────────────

  async getTrending(limit = 20): Promise<RecommendationPodcast[]> {
    const now = Date.now();
    if (now - this._trendingCache.ts < BriefcastAppService.TRENDING_TTL_MS && this._trendingCache.items.length) {
      return this._trendingCache.items.slice(0, limit);
    }

    let imageResource = "default.png";
    try {
      const manifest = await this.mediaResources.getManifest();
      imageResource = manifest.defaults.speakerImage || "default.png";
    } catch { /* use default */ }

    const embeddingModel =
      this.settings.providers.activeProvider === "openai-compatible"
        ? this.settings.providers.openaiCompatible.embeddingModel || "local-hash-v1"
        : "local-hash-v1";

    // Exclude items already in history (listened, used in daily/summary)
    const historySeen = new Set(this.db.getHistory(600).map((item) => item.recommendationId));

    try {
      const headlines = await Promise.race([
        fetchTopHeadlines(limit * 3), // fetch more to account for filtering
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("headlines timeout")), 8000))
      ]);

      const fresh: RecommendationPodcast[] = [];
      for (const h of headlines) {
        // Upsert into DB so podcast generation can find it later
        if (!this.db.articleExistsByUrl(h.url)) {
          const searchable = `${h.title}\n${h.summary}\n${h.content}`.trim();
          if (searchable.length >= 12) {
            const vector = await embedText(this.settings, searchable);
            this.db.upsertArticle(h, vector, embeddingModel);
          }
        }
        const id = this.db.getArticleIdByUrl(h.url);
        if (!id) continue;
        // Skip already-listened items; freshness is handled by ranking.
        if (historySeen.has(id)) continue;
        fresh.push({
          id,
          title: h.title,
          subcategory: h.sourceName,
          sourceName: h.sourceName,
          sourceType: h.sourceType,
          summary: h.summary || h.content || h.title,
          url: h.url,
          publishedAt: h.publishedAt,
          estimatedDurationSeconds: 180,
          imageResource,
          imageUrl: h.imageUrl,
        });
        if (fresh.length >= limit) break;
      }

      if (fresh.length) {
        const ranked = fresh.sort(compareByFreshnessThenPublished);
        this._trendingCache = { ts: now, items: ranked };
        return ranked.slice(0, limit);
      }
    } catch (err) {
      console.warn("[getTrending] live headline fetch failed, falling back to recent articles:", err instanceof Error ? err.message : err);
    }

    // Fallback: most recent articles from DB, excluding history
    const fallback = this.db.getRecommendations(limit * 3, imageResource)
      .filter((item) => !historySeen.has(item.id))
      .sort(compareByFreshnessThenPublished)
      .slice(0, limit);
    this._trendingCache = { ts: now, items: fallback };
    return fallback;
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
    const podcast = this.podcastCache.get(podcastId) ?? this.db.getPodcastById(podcastId);
    return podcast ? this.normalizePodcast(podcast) : null;
  }

  async generatePodcastAudio(recommendationId: string): Promise<Podcast> {
    const cached = this.podcastCache.get(recommendationId) ?? this.db.getPodcastById(recommendationId);
    if (cached && cached.audio_url && cached.transcript_url) {
      const clean = this.normalizePodcast(cached);
      this.podcastCache.set(recommendationId, clean);
      return clean;
    }

    const inFlight = this.podcastGenerationInFlight.get(recommendationId);
    if (inFlight) return inFlight;

    const task = this.podcastGenerationQueue.then(async () => {
      const recheck = this.podcastCache.get(recommendationId) ?? this.db.getPodcastById(recommendationId);
      if (recheck && recheck.audio_url && recheck.transcript_url) {
        const clean = this.normalizePodcast(recheck);
        this.podcastCache.set(recommendationId, clean);
        return clean;
      }

      const manifest = await this.mediaResources.getManifest();
      const imageResource = manifest.defaults.speakerImage || "default.png";
      const rec = this.db.getRecommendationById(recommendationId, imageResource);
      if (!rec) throw new Error(`Recommendation not found: ${recommendationId}`);

      const imageUrl = rec.imageUrl || "/image/default.png";

      // Generate via pipeline (single article, no intro/outro)
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
        skipIntroOutro: true,
      });

      const podcast: Podcast = {
        id: recommendationId,
        title: rec.title,
        subcategory: rec.subcategory,
        source_name: rec.sourceName,
        image_url: imageUrl,
        audio_url: `/audio/${path.basename(pipeline.audioPath)}`,
        transcript_url: `/transcript/${path.basename(pipeline.lrcPath)}`,
        duration_seconds: pipeline.durationSeconds,
        published_at: rec.publishedAt,
        link: rec.url,
        rating: 0,
      };

      this.db.savePodcast(podcast);
      this.podcastCache.set(recommendationId, podcast);
      return podcast;
    });

    const guardedTask = task.finally(() => {
      this.podcastGenerationInFlight.delete(recommendationId);
    });
    this.podcastGenerationInFlight.set(recommendationId, guardedTask);
    this.podcastGenerationQueue = guardedTask.then(() => undefined, () => undefined);
    return guardedTask;
  }

  private async audioFileExists(audioUrl: string): Promise<boolean> {
    try {
      await fs.access(this.mediaUrlToFilePath(audioUrl));
      return true;
    } catch {
      return false;
    }
  }

  // Rewrite any file:// or bare-relative URLs in a stored Podcast to /kind/filename
  // form so all API responses are directly usable by HTTP clients.
  // Persists the fix back to DB so subsequent reads are already clean.
  private normalizePodcast(podcast: Podcast): Podcast {
    const normalized: Podcast = {
      ...podcast,
      audio_url: this.normalizeMediaUrl(podcast.audio_url || "", "audio"),
      transcript_url: this.normalizeMediaUrl(podcast.transcript_url || "", "transcript"),
      image_url: this.normalizeMediaUrl(podcast.image_url || "/image/default.png", "image"),
    };
    if (
      normalized.audio_url !== podcast.audio_url ||
      normalized.transcript_url !== podcast.transcript_url ||
      normalized.image_url !== podcast.image_url
    ) {
      this.db.savePodcast(normalized);
    }
    return normalized;
  }

  async getDailyPodcast(): Promise<Podcast | null> {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `daily-${today}`;
    const existing = this.podcastCache.get(cacheKey) ?? this.db.getDailyPodcast(today);
    if (existing && existing.audio_url && await this.audioFileExists(existing.audio_url)) {
      const clean = this.normalizePodcast(existing);
      this.podcastCache.set(cacheKey, clean);
      console.log("[getDailyPodcast] returning today's cached daily podcast:", cacheKey);
      return clean;
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
    const summaryImage = "/image/summary.png";

    const pipeline = await generateDailyPodcast({
      baseDir: this.baseDir,
      resourceDir: summaryManifest.resourceDir,
      settings: this.settings,
      articles: recs,
      title: `Summary: ${recs.length} Stories`,
      isSummary: true,
      skipIntroOutro: true,
    });

    const summaryId = `summary-${pipeline.id}`;
    const podcast: Podcast = {
      id: summaryId,
      title: pipeline.title,
      subcategory: "News Summary",
      source_name: "BriefCast",
      image_url: summaryImage,
      audio_url: `/audio/${path.basename(pipeline.audioPath)}`,
      transcript_url: `/transcript/${path.basename(pipeline.lrcPath)}`,
      duration_seconds: pipeline.durationSeconds,
      published_at: pipeline.publishedAt,
      link: "",
      is_summary: true,
    };

    this.db.savePodcast(podcast);
    this.podcastCache.set(summaryId, podcast);

    // Mark all used articles as "listened" so they don't appear in recommendations again
    for (const rec of recs) {
      try {
        await this.trackHistory({
          recommendationId: rec.id,
          progressSeconds: 0,
          durationSeconds: 180 // estimated
        });
      } catch {
        // Ignore errors - history tracking is not critical
      }
    }
    console.log(`[generateSummaryPodcast] marked ${recs.length} articles as used`);

    return podcast;
  }

  async forceDailyPodcast(): Promise<Podcast | null> {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `daily-${today}`;
    this.podcastCache.delete(cacheKey);
    // Cancel any running generation so force always starts fresh
    this._dailyPodcastPromise = null;
    this._dailyPodcastDateKey = "";
    return this.generateDailyPodcastInternal();
  }

  private generateDailyPodcastInternal(): Promise<Podcast | null> {
    const today = new Date().toISOString().slice(0, 10);

    // Return the existing in-flight promise — prevents concurrent duplicate runs
    if (this._dailyPodcastPromise && this._dailyPodcastDateKey === today) {
      console.log("[generateDailyPodcastInternal] generation already in flight, joining");
      return this._dailyPodcastPromise;
    }

    // Assign synchronously before any await so all concurrent callers see it immediately
    this._dailyPodcastDateKey = today;
    this._dailyPodcastPromise = this._runDailyPodcastGeneration(today).finally(() => {
      this._dailyPodcastPromise = null;
    });
    return this._dailyPodcastPromise;
  }

  private async _runDailyPodcastGeneration(today: string): Promise<Podcast | null> {
    const cacheKey = `daily-${today}`;

    await this.ensureFreshNews(0);
    const personalizedCount = Math.max(1, Math.min(20, Math.floor(this.settings.preferences.dailyBriefingCount || 5)));
    const hotNewsCount = GLOBAL_HOT_NEWS_COUNT;
    const [hotNews, personalized] = await Promise.all([
      this.getGlobalHotNews(hotNewsCount),
      this.getRecommendations(personalizedCount + hotNewsCount),
    ]);
    const hotIds = new Set(hotNews.map((item) => item.id));
    const recs = uniqueById([
      ...hotNews,
      ...personalized.filter((item) => isFreshArticle(item) && !hotIds.has(item.id)).slice(0, personalizedCount),
    ]);
    if (!recs.length) {
      console.warn("[generateDailyPodcastInternal] no recommendations — cannot generate");
      return null;
    }

    const manifest = await this.mediaResources.getManifest();
    const coverImage = "/image/daily.png";
    const location = await getIpLocation();

    const pipeline = await generateDailyPodcast({
      baseDir: this.baseDir,
      resourceDir: manifest.resourceDir,
      settings: this.settings,
      location: location ?? undefined,
      title: `BriefCast Daily – ${today}`,
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
      audio_url: `/audio/${path.basename(pipeline.audioPath)}`,
      transcript_url: `/transcript/${path.basename(pipeline.lrcPath)}`,
      duration_seconds: pipeline.durationSeconds,
      published_at: pipeline.publishedAt,
      link: "",
      is_daily: true,
    };

    this.db.savePodcast(podcast);
    this.podcastCache.set(cacheKey, podcast);

    // Mark all used articles as "listened" so they don't appear in recommendations again
    for (const rec of recs) {
      try {
        await this.trackHistory({
          recommendationId: rec.id,
          progressSeconds: 0,
          durationSeconds: rec.estimatedDurationSeconds
        });
      } catch {
        // Ignore errors - history tracking is not critical
      }
    }
    console.log(`[generateDailyPodcast] marked ${recs.length} articles as used`);
    return podcast;
  }

  async cleanupOldPodcastFiles(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const podcasts = this.db.getAllPodcasts();
    for (const podcast of podcasts) {
      if (podcast.published_at < cutoff && podcast.audio_url) {
        const filePath = this.mediaUrlToFilePath(podcast.audio_url);
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
