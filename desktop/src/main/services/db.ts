/**
 * BriefCast SQLite database.
 *
 * Single file: <userData>/data/briefcast.db
 *
 * Tables
 * ──────
 *  articles          – ingested news items (with embedding JSON for semantic search)
 *  articles_fts      – FTS5 virtual table for keyword search
 *  briefings         – generated text briefings
 *  history           – listen history
 *  downloads         – saved episodes
 *  podcasts          – generated podcast audio metadata (persisted across restarts)
 *  ratings           – per-podcast like/dislike
 *  users             – registered user accounts
 *  tokens            – API tokens
 *  playlists         – user-created playlists
 *  playlist_items    – playlist membership
 *  rss_feeds         – custom user RSS sources
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { cosineSimilarity } from "./embeddings";
import {
  Article,
  Briefing,
  DownloadPodcastItem,
  DownloadSaveInput,
  HistoryTrackInput,
  ListenHistoryItem,
  Podcast,
  PlaylistInfo,
  ProviderType,
  RecommendationPodcast,
  SearchResult,
} from "../../shared/types";
import { IngestArticle } from "./newsSources";

// ── Internal row shapes ────────────────────────────────────────────────────────

interface ArticleRow {
  id: string;
  title: string;
  url: string;
  source_type: string;
  source_name: string;
  summary: string;
  content: string;
  image_url: string | null;
  published_at: number;
  fetched_at: number;
  embedding: string; // JSON number[]
  embedding_model: string;
}

interface BriefingRow {
  id: string;
  date_key: string;
  content: string;
  provider: string;
  created_at: number;
}

interface HistoryRow {
  id: string;
  recommendation_id: string;
  title: string;
  subcategory: string;
  source_name: string;
  url: string;
  image_resource: string;
  progress_seconds: number;
  duration_seconds: number;
  listened_at: number;
}

interface DownloadRow {
  id: string;
  recommendation_id: string;
  title: string;
  subcategory: string;
  source_name: string;
  url: string;
  summary: string;
  image_resource: string;
  audio_resource: string;
  lyrics_resource: string;
  saved_at: number;
}

interface PodcastRow {
  id: string;
  title: string;
  subcategory: string;
  source_name: string;
  image_url: string;
  audio_url: string;
  transcript_url: string;
  duration_seconds: number;
  published_at: number;
  link: string | null;
  is_daily: number; // 0|1
  is_summary: number; // 0|1
}

interface UserRow {
  id: string;
  password_hash: string;
  topics: string; // JSON string[]
  region: string;
  language: string;
  created_at: number;
}

interface TokenRow {
  token: string;
  user_id: string;
  device_type: string;
  created_at: number;
}

interface PlaylistRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  created_at: number;
}

interface PlaylistItemRow {
  playlist_id: string;
  podcast_id: string;
  added_at: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function estimateDurationSeconds(article: Article): number {
  const text = `${article.title} ${article.summary} ${article.content}`.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(90, Math.min(900, Math.round((words / 150) * 60)));
  return Number.isFinite(seconds) ? seconds : 180;
}

function rowToArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    sourceType: row.source_type as Article["sourceType"],
    sourceName: row.source_name,
    summary: row.summary,
    content: row.content,
    publishedAt: row.published_at,
    imageUrl: row.image_url ?? undefined,
  };
}

function rowToRecommendation(row: ArticleRow, fallbackImage = ""): RecommendationPodcast {
  const article = rowToArticle(row);
  return {
    id: article.id,
    title: article.title,
    subcategory: article.sourceName,
    sourceName: article.sourceName,
    sourceType: article.sourceType,
    summary: article.summary || article.content,
    url: article.url,
    publishedAt: article.publishedAt,
    estimatedDurationSeconds: estimateDurationSeconds(article),
    imageResource: fallbackImage,
    imageUrl: article.imageUrl,
  };
}

function rowToPodcast(row: PodcastRow, rating = 0): Podcast {
  return {
    id: row.id,
    title: row.title,
    subcategory: row.subcategory,
    source_name: row.source_name,
    image_url: row.image_url,
    audio_url: row.audio_url,
    transcript_url: row.transcript_url,
    duration_seconds: row.duration_seconds,
    published_at: row.published_at,
    link: row.link ?? undefined,
    rating,
    is_daily: Boolean(row.is_daily),
    is_summary: Boolean(row.is_summary),
  };
}

// ── Main DB class ──────────────────────────────────────────────────────────────

export class BriefcastDb {
  private readonly db: Database.Database;

  constructor(baseDir: string) {
    const dbDir = path.join(baseDir, "data");
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    this.db = new Database(path.join(dbDir, "briefcast.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  // ── Schema migrations ────────────────────────────────────────────────────────

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        url             TEXT NOT NULL UNIQUE,
        source_type     TEXT NOT NULL DEFAULT 'rss',
        source_name     TEXT NOT NULL DEFAULT '',
        summary         TEXT NOT NULL DEFAULT '',
        content         TEXT NOT NULL DEFAULT '',
        image_url       TEXT,
        published_at    INTEGER NOT NULL DEFAULT 0,
        fetched_at      INTEGER NOT NULL DEFAULT 0,
        embedding       TEXT NOT NULL DEFAULT '[]',
        embedding_model TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_articles_url       ON articles(url);

      CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
        title,
        summary,
        content,
        content='articles',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
        INSERT INTO articles_fts(rowid, title, summary, content)
        VALUES (new.rowid, new.title, new.summary, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
        INSERT INTO articles_fts(articles_fts, rowid, title, summary, content)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
        INSERT INTO articles_fts(articles_fts, rowid, title, summary, content)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content);
        INSERT INTO articles_fts(rowid, title, summary, content)
        VALUES (new.rowid, new.title, new.summary, new.content);
      END;

      CREATE TABLE IF NOT EXISTS briefings (
        id         TEXT PRIMARY KEY,
        date_key   TEXT NOT NULL UNIQUE,
        content    TEXT NOT NULL DEFAULT '',
        provider   TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS history (
        id                TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL,
        title             TEXT NOT NULL DEFAULT '',
        subcategory       TEXT NOT NULL DEFAULT '',
        source_name       TEXT NOT NULL DEFAULT '',
        url               TEXT NOT NULL DEFAULT '',
        image_resource    TEXT NOT NULL DEFAULT '',
        progress_seconds  INTEGER NOT NULL DEFAULT 0,
        duration_seconds  INTEGER NOT NULL DEFAULT 0,
        listened_at       INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_history_listened ON history(listened_at DESC);

      CREATE TABLE IF NOT EXISTS downloads (
        id                TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL UNIQUE,
        title             TEXT NOT NULL DEFAULT '',
        subcategory       TEXT NOT NULL DEFAULT '',
        source_name       TEXT NOT NULL DEFAULT '',
        url               TEXT NOT NULL DEFAULT '',
        summary           TEXT NOT NULL DEFAULT '',
        image_resource    TEXT NOT NULL DEFAULT '',
        audio_resource    TEXT NOT NULL DEFAULT '',
        lyrics_resource   TEXT NOT NULL DEFAULT '',
        saved_at          INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS podcasts (
        id               TEXT PRIMARY KEY,
        title            TEXT NOT NULL DEFAULT '',
        subcategory      TEXT NOT NULL DEFAULT '',
        source_name      TEXT NOT NULL DEFAULT '',
        image_url        TEXT NOT NULL DEFAULT '',
        audio_url        TEXT NOT NULL DEFAULT '',
        transcript_url   TEXT NOT NULL DEFAULT '',
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        published_at     INTEGER NOT NULL DEFAULT 0,
        link             TEXT,
        is_daily         INTEGER NOT NULL DEFAULT 0,
        is_summary       INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS ratings (
        podcast_id TEXT PRIMARY KEY,
        rating     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL DEFAULT '',
        topics        TEXT NOT NULL DEFAULT '[]',
        region        TEXT NOT NULL DEFAULT 'US',
        language      TEXT NOT NULL DEFAULT 'en',
        created_at    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tokens (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        device_type TEXT NOT NULL DEFAULT 'desktop',
        created_at  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

      CREATE TABLE IF NOT EXISTS playlists (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL DEFAULT '',
        name        TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);

      CREATE TABLE IF NOT EXISTS playlist_items (
        playlist_id TEXT NOT NULL,
        podcast_id  TEXT NOT NULL,
        added_at    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (playlist_id, podcast_id)
      );

      CREATE TABLE IF NOT EXISTS rss_feeds (
        url        TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL DEFAULT '',
        added_at   INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  // ── Articles ─────────────────────────────────────────────────────────────────

  articleExistsByUrl(url: string): boolean {
    const row = this.db
      .prepare<[string], { id: string }>("SELECT id FROM articles WHERE url = ? LIMIT 1")
      .get(url);
    return row != null;
  }

  getArticleIdByUrl(url: string): string | null {
    const row = this.db
      .prepare<[string], { id: string }>("SELECT id FROM articles WHERE url = ? LIMIT 1")
      .get(url);
    return row?.id ?? null;
  }

  upsertArticle(
    article: IngestArticle,
    vector: number[],
    embeddingModel: string
  ): "inserted" | "updated" {
    const now = Date.now();
    const embedding = JSON.stringify(vector);

    const existing = this.db
      .prepare<[string], { id: string }>("SELECT id FROM articles WHERE url = ?")
      .get(article.url);

    if (existing) {
      this.db
        .prepare(`
          UPDATE articles SET
            title = ?, source_type = ?, source_name = ?, summary = ?,
            content = ?, image_url = ?, published_at = ?, fetched_at = ?,
            embedding = ?, embedding_model = ?
          WHERE url = ?
        `)
        .run(
          article.title, article.sourceType, article.sourceName,
          article.summary ?? "", article.content ?? "",
          article.imageUrl ?? null, article.publishedAt, now,
          embedding, embeddingModel,
          article.url
        );
      return "updated";
    }

    this.db
      .prepare(`
        INSERT INTO articles
          (id, title, url, source_type, source_name, summary, content,
           image_url, published_at, fetched_at, embedding, embedding_model)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .run(
        randomUUID(), article.title, article.url,
        article.sourceType, article.sourceName,
        article.summary ?? "", article.content ?? "",
        article.imageUrl ?? null, article.publishedAt, now,
        embedding, embeddingModel
      );
    return "inserted";
  }

  /**
   * Update just the image_url for an existing article (by URL) if it currently has no image.
   * Returns true if an update was made, false otherwise.
   */
  updateArticleImageIfMissing(articleUrl: string, imageUrl: string): boolean {
    if (!imageUrl) return false;
    const result = this.db
      .prepare("UPDATE articles SET image_url = ? WHERE url = ? AND (image_url IS NULL OR image_url = '')")
      .run(imageUrl, articleUrl);
    return result.changes > 0;
  }

  /** Get articles missing images (for enrichment). */
  getArticlesMissingImages(limit = 100): Array<{ url: string }> {
    return this.db
      .prepare<[number], { url: string }>(
        "SELECT url FROM articles WHERE image_url IS NULL OR image_url = '' ORDER BY published_at DESC LIMIT ?"
      )
      .all(limit);
  }

  /** FTS5 keyword search — uses SQLite full-text index. */
  keywordSearch(query: string, limit = 30): SearchResult[] {
    if (!query.trim()) return [];

    // Escape FTS5 special characters
    const escaped = query.trim().replace(/["']/g, " ");

    try {
      const rows = this.db
        .prepare<[string, number], ArticleRow & { rank: number }>(`
          SELECT a.*, fts.rank
          FROM articles_fts fts
          JOIN articles a ON a.rowid = fts.rowid
          WHERE articles_fts MATCH ?
          ORDER BY fts.rank
          LIMIT ?
        `)
        .all(escaped, limit);

      return rows.map((row) => ({
        ...rowToArticle(row),
        keywordScore: 1 / (1 + Math.abs(row.rank)),
      }));
    } catch {
      // Fallback to LIKE search if FTS query is malformed
      const like = `%${query.trim()}%`;
      const rows = this.db
        .prepare<[string, string, string, number], ArticleRow>(`
          SELECT * FROM articles
          WHERE title LIKE ? OR summary LIKE ? OR content LIKE ?
          ORDER BY published_at DESC
          LIMIT ?
        `)
        .all(like, like, like, limit);
      return rows.map((row) => ({ ...rowToArticle(row), keywordScore: 0.5 }));
    }
  }

  /** Cosine-similarity semantic search using stored embeddings. */
  semanticSearch(queryVector: number[], limit = 30): SearchResult[] {
    if (!queryVector.length) return [];

    const rows = this.db
      .prepare<[], ArticleRow>("SELECT * FROM articles ORDER BY published_at DESC LIMIT 2000")
      .all();

    return rows
      .map((row) => {
        const vec: number[] = JSON.parse(row.embedding || "[]");
        return {
          ...rowToArticle(row),
          semanticScore: vec.length ? cosineSimilarity(queryVector, vec) : 0,
        };
      })
      .filter((r) => (r.semanticScore ?? 0) > 0)
      .sort((a, b) => (b.semanticScore ?? 0) - (a.semanticScore ?? 0))
      .slice(0, limit);
  }

  /** Hybrid: FTS5 keyword (60%) + cosine semantic (40%). */
  hybridSearch(query: string, queryVector: number[], limit = 30): SearchResult[] {
    const keyword = this.keywordSearch(query, limit * 3);
    const semantic = this.semanticSearch(queryVector, limit * 3);

    const merged = new Map<string, SearchResult>();

    for (const item of keyword) {
      merged.set(item.id, { ...item, hybridScore: (item.keywordScore ?? 0) * 0.6 });
    }

    for (const item of semantic) {
      const existing = merged.get(item.id);
      if (existing) {
        merged.set(item.id, {
          ...existing,
          semanticScore: item.semanticScore,
          hybridScore: (existing.hybridScore ?? 0) + (item.semanticScore ?? 0) * 0.4,
        });
      } else {
        merged.set(item.id, { ...item, hybridScore: (item.semanticScore ?? 0) * 0.4 });
      }
    }

    return [...merged.values()]
      .sort((a, b) => (b.hybridScore ?? 0) - (a.hybridScore ?? 0))
      .slice(0, limit);
  }

  recentArticles(limit = 50): SearchResult[] {
    return this.db
      .prepare<[number], ArticleRow>("SELECT * FROM articles ORDER BY published_at DESC LIMIT ?")
      .all(limit)
      .map(rowToArticle);
  }

  /** FTS5 search filtered to financial topics (finance, markets, economy, etc.). */
  financialNews(limit = 30): SearchResult[] {
    const ftsQuery =
      "finance OR stock OR market OR economy OR investment OR earnings OR trading OR cryptocurrency OR fintech OR banking OR \"interest rate\" OR \"federal reserve\" OR GDP OR inflation";
    try {
      const rows = this.db
        .prepare<[string, number], ArticleRow & { rank: number }>(`
          SELECT a.*, fts.rank
          FROM articles_fts fts
          JOIN articles a ON a.rowid = fts.rowid
          WHERE articles_fts MATCH ?
          ORDER BY fts.rank
          LIMIT ?
        `)
        .all(ftsQuery, limit);
      return rows.map((row) => ({ ...rowToArticle(row), keywordScore: 1 / (1 + Math.abs(row.rank)) }));
    } catch {
      // FTS fallback: LIKE search on common financial keywords
      const rows = this.db
        .prepare<[string, string, string, string, string, number], ArticleRow>(`
          SELECT * FROM articles
          WHERE title LIKE ? OR title LIKE ? OR title LIKE ?
             OR summary LIKE ? OR content LIKE ?
          ORDER BY published_at DESC
          LIMIT ?
        `)
        .all("%finance%", "%stock%", "%market%", "%economy%", "%invest%", limit);
      return rows.map((row) => ({ ...rowToArticle(row), keywordScore: 0.5 }));
    }
  }

  getRecommendations(limit = 100, fallbackImage = ""): RecommendationPodcast[] {
    return this.db
      .prepare<[number], ArticleRow>("SELECT * FROM articles ORDER BY published_at DESC LIMIT ?")
      .all(limit)
      .map((row) => rowToRecommendation(row, fallbackImage));
  }

  getRecommendationById(id: string, fallbackImage = ""): RecommendationPodcast | null {
    const row = this.db
      .prepare<[string], ArticleRow>("SELECT * FROM articles WHERE id = ?")
      .get(id);
    return row ? rowToRecommendation(row, fallbackImage) : null;
  }

  getArticleById(id: string): Article | null {
    const row = this.db
      .prepare<[string], ArticleRow>("SELECT * FROM articles WHERE id = ?")
      .get(id);
    return row ? rowToArticle(row) : null;
  }

  // ── Briefings ─────────────────────────────────────────────────────────────────

  saveBriefing(dateKey: string, content: string, provider: string): Briefing {
    const existing = this.db
      .prepare<[string], BriefingRow>("SELECT * FROM briefings WHERE date_key = ?")
      .get(dateKey);

    if (existing) {
      this.db
        .prepare("UPDATE briefings SET content = ?, provider = ? WHERE date_key = ?")
        .run(content, provider, dateKey);
      return {
        id: existing.id,
        dateKey,
        content,
        provider: provider as ProviderType,
        createdAt: existing.created_at,
      };
    }

    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO briefings (id, date_key, content, provider, created_at) VALUES (?,?,?,?,?)")
      .run(id, dateKey, content, provider, now);

    return { id, dateKey, content, provider: provider as ProviderType, createdAt: now };
  }

  getBriefings(limit = 20): Briefing[] {
    return this.db
      .prepare<[number], BriefingRow>("SELECT * FROM briefings ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => ({
        id: row.id,
        dateKey: row.date_key,
        content: row.content,
        provider: row.provider as ProviderType,
        createdAt: row.created_at,
      }));
  }

  // ── History ───────────────────────────────────────────────────────────────────

  trackHistory(input: HistoryTrackInput, fallbackImage = ""): ListenHistoryItem {
    const article = this.getArticleById(input.recommendationId);
    const podcast = !article ? this.getPodcastById(input.recommendationId) : null;
    const base = article
      ? { title: article.title, sourceName: article.sourceName, url: article.url, id: input.recommendationId }
      : {
          title: podcast?.title ?? "",
          sourceName: podcast?.source_name ?? "",
          url: podcast?.link ?? "",
          id: input.recommendationId
        };

    const durationSeconds =
      Number.isFinite(input.durationSeconds) && (input.durationSeconds ?? 0) > 0
        ? Math.floor(input.durationSeconds as number)
        : article ? estimateDurationSeconds(article as Article) : 180;

    const progressSeconds = Math.min(
      Number.isFinite(input.progressSeconds) && (input.progressSeconds ?? 0) >= 0
        ? Math.floor(input.progressSeconds as number)
        : 0,
      durationSeconds
    );

    const id = randomUUID();
    const now = Date.now();
    const podcastImageResource =
      podcast?.image_url && podcast.image_url.trim()
        ? path.basename(podcast.image_url.startsWith("file://") ? podcast.image_url.slice(7) : podcast.image_url)
        : "";
    const imageResource = podcastImageResource || fallbackImage;

    this.db
      .prepare(`
        INSERT INTO history
          (id, recommendation_id, title, subcategory, source_name, url,
           image_resource, progress_seconds, duration_seconds, listened_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `)
      .run(
        id, input.recommendationId,
        base.title, base.sourceName,
        base.sourceName, base.url,
        imageResource, progressSeconds, durationSeconds, now
      );

    return {
      id,
      recommendationId: input.recommendationId,
      title: base.title,
      subcategory: base.sourceName,
      sourceName: base.sourceName,
      url: base.url,
      imageResource,
      progressSeconds,
      durationSeconds,
      listenedAt: now,
    };
  }

  getHistory(limit = 200): ListenHistoryItem[] {
    return this.db
      .prepare<[number], HistoryRow & { article_image_url: string | null }>(
        `SELECT h.*, a.image_url AS article_image_url
         FROM history h
         LEFT JOIN articles a ON a.id = h.recommendation_id
         ORDER BY h.listened_at DESC LIMIT ?`
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        recommendationId: row.recommendation_id,
        title: row.title,
        subcategory: row.subcategory,
        sourceName: row.source_name,
        url: row.url,
        imageResource: row.image_resource,
        imageUrl: row.article_image_url ?? undefined,
        progressSeconds: row.progress_seconds,
        durationSeconds: row.duration_seconds,
        listenedAt: row.listened_at,
      }));
  }

  // ── Preference signals ────────────────────────────────────────────────────────

  /** History items from the last N days where the user listened to ≥ minRatio of the episode. */
  getEngagedHistory(days = 30, minCompletionRatio = 0.6): Array<{
    source_name: string;
    recommendation_id: string;
    progress_seconds: number;
    duration_seconds: number;
    listened_at: number;
  }> {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.db
      .prepare<[number, number], {
        source_name: string; recommendation_id: string;
        progress_seconds: number; duration_seconds: number; listened_at: number;
      }>(
        `SELECT source_name, recommendation_id, progress_seconds, duration_seconds, listened_at
         FROM history
         WHERE listened_at >= ?
           AND duration_seconds > 0
           AND CAST(progress_seconds AS REAL) / duration_seconds >= ?
         ORDER BY listened_at DESC LIMIT 200`
      )
      .all(since, minCompletionRatio);
  }

  /** source_type engagement counts for recently completed listens (joined with articles). */
  getEngagedSourceTypes(days = 30): Array<{ source_type: string; count: number }> {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.db
      .prepare<[number], { source_type: string; count: number }>(
        `SELECT a.source_type, COUNT(*) AS count
         FROM history h
         JOIN articles a ON a.id = h.recommendation_id
         WHERE h.listened_at >= ?
           AND h.duration_seconds > 0
           AND CAST(h.progress_seconds AS REAL) / h.duration_seconds >= 0.5
         GROUP BY a.source_type
         ORDER BY count DESC LIMIT 10`
      )
      .all(since);
  }

  /** source_name and subcategory from podcasts that received a positive rating. */
  getPositivelyRatedSources(): Array<{ source_name: string; subcategory: string }> {
    return this.db
      .prepare<[], { source_name: string; subcategory: string }>(
        `SELECT p.source_name, p.subcategory
         FROM ratings r
         JOIN podcasts p ON p.id = r.podcast_id
         WHERE r.rating > 0
         LIMIT 50`
      )
      .all();
  }

  // ── Downloads ─────────────────────────────────────────────────────────────────

  saveDownload(
    input: DownloadSaveInput,
    defaults: { imageResource: string; audioResource: string; lyricsResource: string }
  ): DownloadPodcastItem {
    const article = this.getArticleById(input.recommendationId);
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(`
        INSERT INTO downloads
          (id, recommendation_id, title, subcategory, source_name, url, summary,
           image_resource, audio_resource, lyrics_resource, saved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(recommendation_id) DO UPDATE SET
          title = excluded.title, image_resource = excluded.image_resource,
          audio_resource = excluded.audio_resource, lyrics_resource = excluded.lyrics_resource,
          saved_at = excluded.saved_at
      `)
      .run(
        id, input.recommendationId,
        article?.title ?? "", article?.sourceName ?? "", article?.sourceName ?? "",
        article?.url ?? "",
        article?.summary ?? article?.content ?? "",
        input.imageResource || defaults.imageResource,
        input.audioResource || defaults.audioResource,
        input.lyricsResource || defaults.lyricsResource,
        now
      );

    const row = this.db
      .prepare<[string], DownloadRow>("SELECT * FROM downloads WHERE recommendation_id = ?")
      .get(input.recommendationId)!;

    return {
      id: row.id,
      recommendationId: row.recommendation_id,
      title: row.title,
      subcategory: row.subcategory,
      sourceName: row.source_name,
      url: row.url,
      summary: row.summary,
      imageResource: row.image_resource,
      audioResource: row.audio_resource,
      lyricsResource: row.lyrics_resource,
      savedAt: row.saved_at,
    };
  }

  getDownloads(limit = 500): DownloadPodcastItem[] {
    return this.db
      .prepare<[number], DownloadRow & { article_image_url: string | null }>(
        `SELECT d.*, a.image_url AS article_image_url
         FROM downloads d
         LEFT JOIN articles a ON a.id = d.recommendation_id
         ORDER BY d.saved_at DESC LIMIT ?`
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        recommendationId: row.recommendation_id,
        title: row.title,
        subcategory: row.subcategory,
        sourceName: row.source_name,
        url: row.url,
        summary: row.summary,
        imageResource: row.image_resource,
        imageUrl: row.article_image_url ?? undefined,
        audioResource: row.audio_resource,
        lyricsResource: row.lyrics_resource,
        savedAt: row.saved_at,
      }));
  }

  removeDownload(id: string): boolean {
    const result = this.db.prepare("DELETE FROM downloads WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ── Podcasts ──────────────────────────────────────────────────────────────────

  savePodcast(podcast: Podcast): void {
    this.db
      .prepare(`
        INSERT INTO podcasts
          (id, title, subcategory, source_name, image_url, audio_url, transcript_url,
           duration_seconds, published_at, link, is_daily, is_summary)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title, audio_url = excluded.audio_url,
          transcript_url = excluded.transcript_url,
          duration_seconds = excluded.duration_seconds
      `)
      .run(
        podcast.id, podcast.title, podcast.subcategory, podcast.source_name,
        podcast.image_url, podcast.audio_url, podcast.transcript_url,
        podcast.duration_seconds, podcast.published_at, podcast.link ?? null,
        podcast.is_daily ? 1 : 0, podcast.is_summary ? 1 : 0
      );
  }

  getPodcastById(id: string): Podcast | null {
    const row = this.db
      .prepare<[string], PodcastRow>("SELECT * FROM podcasts WHERE id = ?")
      .get(id);
    if (!row) return null;
    const ratingRow = this.db
      .prepare<[string], { rating: number }>("SELECT rating FROM ratings WHERE podcast_id = ?")
      .get(id);
    return rowToPodcast(row, ratingRow?.rating ?? 0);
  }

  getAllPodcasts(): Podcast[] {
    return this.db
      .prepare<[], PodcastRow>("SELECT * FROM podcasts ORDER BY published_at DESC")
      .all()
      .map((row) => rowToPodcast(row, 0));
  }

  getDailyPodcast(dateKey: string): Podcast | null {
    const row = this.db
      .prepare<[string], PodcastRow>(
        "SELECT * FROM podcasts WHERE is_daily = 1 AND date(published_at/1000,'unixepoch') = ? ORDER BY published_at DESC LIMIT 1"
      )
      .get(dateKey);
    if (!row) return null;
    const ratingRow = this.db
      .prepare<[string], { rating: number }>("SELECT rating FROM ratings WHERE podcast_id = ?")
      .get(row.id);
    return rowToPodcast(row, ratingRow?.rating ?? 0);
  }

  ratePodcast(podcastId: string, rating: number): void {
    this.db
      .prepare("INSERT INTO ratings (podcast_id, rating) VALUES (?,?) ON CONFLICT(podcast_id) DO UPDATE SET rating = excluded.rating")
      .run(podcastId, rating);
  }

  // ── Users ─────────────────────────────────────────────────────────────────────

  createUser(id: string, passwordHash: string, topics: string[], region: string, language: string): void {
    this.db
      .prepare(`
        INSERT INTO users (id, password_hash, topics, region, language, created_at)
        VALUES (?,?,?,?,?,?)
      `)
      .run(id, passwordHash, JSON.stringify(topics), region, language, Date.now());
  }

  getUserById(id: string): UserRow | null {
    return this.db
      .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
      .get(id) ?? null;
  }

  updateUser(id: string, topics: string[], region: string, language: string): void {
    this.db
      .prepare("UPDATE users SET topics = ?, region = ?, language = ? WHERE id = ?")
      .run(JSON.stringify(topics), region, language, id);
  }

  // ── Tokens ────────────────────────────────────────────────────────────────────

  createToken(token: string, userId: string, deviceType = "desktop"): void {
    this.db
      .prepare("INSERT INTO tokens (token, user_id, device_type, created_at) VALUES (?,?,?,?)")
      .run(token, userId, deviceType, Date.now());
  }

  getTokensByUser(userId: string): TokenRow[] {
    return this.db
      .prepare<[string], TokenRow>("SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId);
  }

  getTokenRow(token: string): TokenRow | null {
    return this.db
      .prepare<[string], TokenRow>("SELECT * FROM tokens WHERE token = ?")
      .get(token) ?? null;
  }

  revokeToken(token: string): void {
    this.db.prepare("DELETE FROM tokens WHERE token = ?").run(token);
  }

  // ── Playlists ─────────────────────────────────────────────────────────────────

  createPlaylist(userId: string, name: string, description = ""): PlaylistInfo {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO playlists (id, user_id, name, description, created_at) VALUES (?,?,?,?,?)")
      .run(id, userId, name, description, now);
    return { id, name, description, createdAt: now, items: [] };
  }

  getPlaylistsByUser(userId: string): PlaylistInfo[] {
    const rows = this.db
      .prepare<[string], PlaylistRow>("SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId);

    return rows.map((pl) => {
      const itemRows = this.db
        .prepare<[string], PlaylistItemRow>(
          "SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY added_at ASC"
        )
        .all(pl.id);

      const items = itemRows
        .map((i) => {
          const p = this.getPodcastById(i.podcast_id);
          if (!p) return null;
          return {
            id: p.id,
            title: p.title,
            subcategory: p.subcategory,
            image_url: p.image_url,
            audio_url: p.audio_url,
            transcript_url: p.transcript_url,
            duration_seconds: p.duration_seconds,
            published_at: p.published_at,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      return {
        id: pl.id,
        name: pl.name,
        description: pl.description,
        createdAt: pl.created_at,
        items,
      };
    });
  }

  deletePlaylist(id: string): void {
    this.db.prepare("DELETE FROM playlist_items WHERE playlist_id = ?").run(id);
    this.db.prepare("DELETE FROM playlists WHERE id = ?").run(id);
  }

  addToPlaylist(playlistId: string, podcastId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO playlist_items (playlist_id, podcast_id, added_at) VALUES (?,?,?)"
      )
      .run(playlistId, podcastId, Date.now());
  }

  removeFromPlaylist(playlistId: string, podcastId: string): void {
    this.db
      .prepare("DELETE FROM playlist_items WHERE playlist_id = ? AND podcast_id = ?")
      .run(playlistId, podcastId);
  }

  // ── RSS feeds ─────────────────────────────────────────────────────────────────

  addRssFeed(url: string, userId = ""): void {
    this.db
      .prepare("INSERT OR IGNORE INTO rss_feeds (url, user_id, added_at) VALUES (?,?,?)")
      .run(url, userId, Date.now());
  }

  removeRssFeed(url: string): void {
    this.db.prepare("DELETE FROM rss_feeds WHERE url = ?").run(url);
  }

  getRssFeeds(userId = ""): string[] {
    return this.db
      .prepare<[string], { url: string }>(
        "SELECT url FROM rss_feeds WHERE user_id = ? OR user_id = '' ORDER BY added_at ASC"
      )
      .all(userId)
      .map((r) => r.url);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
