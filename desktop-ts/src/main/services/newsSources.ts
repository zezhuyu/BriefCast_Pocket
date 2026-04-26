import Parser from "rss-parser";

export interface IngestArticle {
  title: string;
  url: string;
  sourceType: "rss" | "hackernews" | "reddit" | "devto" | "lobsters" | "googlenews" | "github-trending" | "slashdot" | "producthunt";
  sourceName: string;
  summary: string;
  content: string;
  publishedAt: number;
  imageUrl?: string;
}

// 8-second timeout per feed — enough for slow servers, not so long that it blocks everything
const parser = new Parser({ timeout: 8000 });

// Max feeds to attempt per sync — avoids extremely long sync times with large catalogs
const MAX_RSS_FEEDS = 30;
// Concurrent feed fetch limit
const RSS_CONCURRENCY = 10;

function toTimestamp(value?: string): number {
  if (!value) {
    return Date.now();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function safeSummary(input?: string): string {
  if (!input) {
    return "";
  }
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function firstHttp(...candidates: Array<string | undefined | null>): string | undefined {
  for (const value of candidates) {
    if (value && isHttpUrl(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeUrlCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return isHttpUrl(value) ? value : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct = normalizeUrlCandidate(record.url);
    if (direct) return direct;
    const href = normalizeUrlCandidate(record.href);
    if (href) return href;
    const dollar = record.$ as Record<string, unknown> | undefined;
    if (dollar) {
      const nested = normalizeUrlCandidate(dollar.url) ?? normalizeUrlCandidate(dollar.href);
      if (nested) return nested;
    }
  }
  return undefined;
}

function firstFromList(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return normalizeUrlCandidate(value);
  }
  for (const item of value) {
    const candidate = normalizeUrlCandidate(item);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function extractImageFromHtml(html?: string): string | undefined {
  if (!html) return undefined;
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1] && isHttpUrl(og[1])) return og[1];
  const twitter = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (twitter?.[1] && isHttpUrl(twitter[1])) return twitter[1];
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img?.[1] && isHttpUrl(img[1])) return img[1];
  return undefined;
}

function extractRssItemImage(item: Record<string, unknown>): string | undefined {
  return firstHttp(
    firstFromList(item["media:thumbnail"]),
    firstFromList(item.media_thumbnail),
    firstFromList(item["media:content"]),
    firstFromList(item.media_content),
    normalizeUrlCandidate(item["itunes:image"]),
    firstFromList(item.enclosures),
    normalizeUrlCandidate(item.enclosure),
    extractImageFromHtml(typeof item["content:encoded"] === "string" ? item["content:encoded"] : undefined),
    extractImageFromHtml(typeof item.content === "string" ? item.content : undefined),
    extractImageFromHtml(typeof item.summary === "string" ? item.summary : undefined)
  );
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

export async function fetchOneFeed(feedUrl: string, maxPerFeed: number): Promise<IngestArticle[]> {
  const feed = await parser.parseURL(feedUrl);
  const result: IngestArticle[] = [];
  for (const item of (feed.items ?? []).slice(0, maxPerFeed)) {
    const itemRecord = item as unknown as Record<string, unknown>;
    const url = (itemRecord.link as string | undefined) ?? "";
    const title = (itemRecord.title as string | undefined) ?? "";
    if (!url || !title || !isHttpUrl(url)) continue;
    result.push({
      title,
      url,
      sourceType: "rss",
      sourceName: feed.title ?? new URL(feedUrl).hostname,
      summary: safeSummary((itemRecord.contentSnippet as string | undefined) ?? (itemRecord.summary as string | undefined)),
      content: safeSummary(
        (itemRecord["content:encoded"] as string | undefined) ??
          (itemRecord.content as string | undefined) ??
          (itemRecord.contentSnippet as string | undefined)
      ),
      publishedAt: toTimestamp((itemRecord.isoDate as string | undefined) ?? (itemRecord.pubDate as string | undefined)),
      imageUrl: extractRssItemImage(itemRecord)
    });
  }
  return result;
}

export async function fetchRssNews(feeds: string[], maxPerFeed = 20): Promise<IngestArticle[]> {
  // Cap total feeds to avoid multi-minute syncs
  const selected = feeds.slice(0, MAX_RSS_FEEDS);
  console.log(`[fetchRssNews] fetching ${selected.length}/${feeds.length} feeds (cap: ${MAX_RSS_FEEDS}), concurrency: ${RSS_CONCURRENCY}`);

  const output: IngestArticle[] = [];

  // Process in parallel batches of RSS_CONCURRENCY
  for (let i = 0; i < selected.length; i += RSS_CONCURRENCY) {
    const batch = selected.slice(i, i + RSS_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((url) => fetchOneFeed(url, maxPerFeed)));
    let batchOk = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        output.push(...r.value);
        batchOk++;
      }
    }
    console.log(`[fetchRssNews] batch ${Math.floor(i / RSS_CONCURRENCY) + 1}: ${batchOk}/${batch.length} feeds ok, ${output.length} articles so far`);
  }

  return output;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function fetchHackerNews(limit = 30): Promise<IngestArticle[]> {
  type HnItem = { id: number; title?: string; url?: string; time?: number; by?: string; text?: string };

  const ids = await fetchJson<number[]>("https://hacker-news.firebaseio.com/v0/topstories.json");
  const selectedIds = ids.slice(0, limit);

  const articles = await Promise.all(
    selectedIds.map(async (id) => {
      const item = await fetchJson<HnItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (!item?.title || !item?.url || !isHttpUrl(item.url)) {
        return null;
      }
      return {
        title: item.title,
        url: item.url,
        sourceType: "hackernews" as const,
        sourceName: "Hacker News",
        summary: item.text ? safeSummary(item.text) : "Hacker News top story",
        content: item.text ? safeSummary(item.text) : item.title,
        publishedAt: (item.time ?? Math.floor(Date.now() / 1000)) * 1000,
        imageUrl: undefined
      };
    })
  );

  const filtered: IngestArticle[] = [];
  for (const article of articles) {
    if (article) {
      filtered.push(article);
    }
  }
  return filtered;
}

export async function fetchReddit(subreddits: string[], perSubreddit = 20): Promise<IngestArticle[]> {
  type RedditResponse = {
    data?: {
      children?: Array<{
        data?: {
          title?: string;
          url?: string;
          permalink?: string;
          selftext?: string;
          created_utc?: number;
          subreddit?: string;
        };
      }>;
    };
  };

  const all: IngestArticle[] = [];

  for (const subreddit of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${perSubreddit}`;
      const json = await fetchJson<RedditResponse>(url, {
        headers: {
          "User-Agent": "BriefCastDesktopTS/0.1"
        }
      });

      const posts = json.data?.children ?? [];
      for (const post of posts) {
        const data = post.data;
        const title = data?.title ?? "";
        const externalUrl = data?.url ?? "";
        if (!title || !externalUrl || !isHttpUrl(externalUrl)) {
          continue;
        }

        all.push({
          title,
          url: externalUrl,
          sourceType: "reddit",
          sourceName: `r/${data?.subreddit ?? subreddit}`,
          summary: safeSummary(data?.selftext ?? "Reddit discussion"),
          content: safeSummary(`${data?.selftext ?? ""}\n${title}`),
          publishedAt: Math.floor((data?.created_utc ?? Date.now() / 1000) * 1000),
          imageUrl: firstHttp(
            (data as unknown as { thumbnail?: string })?.thumbnail,
            (data as unknown as { url_overridden_by_dest?: string })?.url_overridden_by_dest,
            externalUrl
          )
        });
      }
    } catch {
      continue;
    }
  }

  return all;
}

// ── Article image scraping ─────────────────────────────────────────────────────
// Concurrency limit for scraping article pages to extract og:image
const IMAGE_SCRAPE_CONCURRENCY = 5;

/** Fetch the article page and extract og:image / twitter:image from the HTML. */
async function scrapeArticleImage(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BriefCastBot/1.0)",
        "Accept": "text/html"
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    // Only read first 20KB — og:image is always in <head>
    const reader = res.body?.getReader();
    if (!reader) return undefined;
    let html = "";
    while (html.length < 20000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel().catch(() => {});
    return extractImageFromHtml(html);
  } catch {
    return undefined;
  }
}

/**
 * For articles that have no imageUrl, attempt to scrape one from the article page.
 * Runs up to IMAGE_SCRAPE_CONCURRENCY fetches in parallel.
 */
export async function enrichWithArticleImages(articles: IngestArticle[]): Promise<IngestArticle[]> {
  const missing = articles.filter((a) => !a.imageUrl);
  console.log(`[enrichImages] scraping images for ${missing.length}/${articles.length} articles without images`);

  // Process in batches
  for (let i = 0; i < missing.length; i += IMAGE_SCRAPE_CONCURRENCY) {
    const batch = missing.slice(i, i + IMAGE_SCRAPE_CONCURRENCY);
    await Promise.all(
      batch.map(async (article) => {
        const img = await scrapeArticleImage(article.url);
        if (img) article.imageUrl = img;
      })
    );
  }

  return articles;
}

// ── Dev.to ─────────────────────────────────────────────────────────────────────

export async function fetchDevTo(tags: string[], perTag = 15): Promise<IngestArticle[]> {
  type DevToArticle = {
    id: number;
    title: string;
    url: string;
    description?: string;
    body_markdown?: string;
    cover_image?: string | null;
    social_image?: string | null;
    published_at?: string;
    tag_list?: string[];
    user?: { name?: string };
  };

  const all: IngestArticle[] = [];

  for (const tag of tags) {
    try {
      const apiUrl = `https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&per_page=${perTag}&state=fresh`;
      const articles = await fetchJson<DevToArticle[]>(apiUrl, {
        headers: { "User-Agent": "BriefCastDesktopTS/0.1" }
      });

      for (const a of articles) {
        if (!a.title || !a.url || !isHttpUrl(a.url)) continue;
        all.push({
          title: a.title,
          url: a.url,
          sourceType: "devto",
          sourceName: `Dev.to / #${tag}`,
          summary: safeSummary(a.description),
          content: safeSummary(a.body_markdown ?? a.description),
          publishedAt: toTimestamp(a.published_at),
          imageUrl: firstHttp(a.cover_image ?? undefined, a.social_image ?? undefined)
        });
      }
    } catch {
      continue;
    }
  }

  return all;
}

// ── Lobste.rs ──────────────────────────────────────────────────────────────────

export async function fetchLobsters(limit = 30): Promise<IngestArticle[]> {
  type LobstersItem = {
    short_id: string;
    title: string;
    url?: string;
    comments_url?: string;
    description?: string;
    created_at?: string;
    tags?: string[];
    submitter_user?: { username?: string };
  };

  type LobstersResponse = { stories?: LobstersItem[] } | LobstersItem[];

  const raw = await fetchJson<LobstersResponse>("https://lobste.rs/hottest.json", {
    headers: { "User-Agent": "BriefCastDesktopTS/0.1" }
  });

  const items: LobstersItem[] = Array.isArray(raw) ? raw : ((raw as { stories?: LobstersItem[] }).stories ?? []);

  return items
    .slice(0, limit)
    .filter((item) => item.title && (item.url || item.comments_url))
    .map((item) => ({
      title: item.title,
      url: item.url && isHttpUrl(item.url) ? item.url : (item.comments_url ?? ""),
      sourceType: "lobsters" as const,
      sourceName: "Lobste.rs",
      summary: safeSummary(item.description),
      content: safeSummary(item.description ?? item.title),
      publishedAt: toTimestamp(item.created_at),
      imageUrl: undefined
    }))
    .filter((a) => isHttpUrl(a.url));
}

// ── Google News RSS ────────────────────────────────────────────────────────────
// Uses Google News's public RSS search endpoint — no API key required.

export async function fetchGoogleNews(topics: string[], perTopic = 15): Promise<IngestArticle[]> {
  const all: IngestArticle[] = [];

  for (const topic of topics) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`;
      const articles = await fetchOneFeed(rssUrl, perTopic);
      // Override sourceType since fetchOneFeed labels everything "rss"
      for (const a of articles) {
        all.push({ ...a, sourceType: "googlenews", sourceName: `Google News / ${topic}` });
      }
    } catch {
      continue;
    }
  }

  return all;
}

// ── GitHub Trending ────────────────────────────────────────────────────────────
// Scrapes GitHub's public trending page — no API key or auth required.
// Surfaces what the developer community is excited about as "tech news".

export async function fetchGithubTrending(limit = 25): Promise<IngestArticle[]> {
  const res = await fetch("https://github.com/trending?since=daily", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`GitHub trending HTTP ${res.status}`);
  const html = await res.text();

  // Repo slugs are in <h2> tags: href="/owner/repo"
  const h2Pattern = /<h2[^>]*>[\s\S]*?href="\/([\w.-]+\/[\w.-]+)"/g;
  const slugMatches = [...html.matchAll(h2Pattern)].map(m => m[1]);

  // Descriptions are in <p class="col-9 ...">
  const descPattern = /<p[^>]*col-9[^>]*>([\s\S]*?)<\/p>/g;
  const descs = [...html.matchAll(descPattern)].map(m =>
    m[1].trim().replace(/\s+/g, " ")
  );

  const out: IngestArticle[] = [];
  for (let i = 0; i < Math.min(slugMatches.length, limit); i++) {
    const slug = slugMatches[i];
    // Skip GitHub-internal navigation paths
    if (slug.startsWith("sponsors/") || slug.startsWith("apps/") || slug.startsWith("trending/")) continue;
    const url = `https://github.com/${slug}`;
    const desc = descs[i] ?? "";
    const title = `${slug}${desc ? ` — ${desc.slice(0, 120)}` : ""}`;
    out.push({
      title,
      url,
      sourceType: "github-trending",
      sourceName: "GitHub Trending",
      summary: desc,
      content: desc || slug,
      publishedAt: Date.now(),
      imageUrl: undefined
    });
  }
  return out;
}

// ── Slashdot ───────────────────────────────────────────────────────────────────
// Long-running tech/science/politics community news. Free public RSS.

export async function fetchSlashdot(limit = 20): Promise<IngestArticle[]> {
  const articles = await fetchOneFeed("https://rss.slashdot.org/Slashdot/slashdotMain", limit);
  return articles.map(a => ({ ...a, sourceType: "slashdot" as const, sourceName: "Slashdot" }));
}

// ── ProductHunt ────────────────────────────────────────────────────────────────
// Latest product launches — free public RSS, good signal for tech/startup news.

export async function fetchProductHunt(limit = 25): Promise<IngestArticle[]> {
  const articles = await fetchOneFeed("https://www.producthunt.com/feed", limit);
  return articles.map(a => ({ ...a, sourceType: "producthunt" as const, sourceName: "ProductHunt" }));
}

export function dedupeArticles(articles: IngestArticle[]): IngestArticle[] {
  const seen = new Set<string>();
  const out: IngestArticle[] = [];

  for (const article of articles) {
    const key = article.url;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(article);
  }

  return out;
}
