import Parser from "rss-parser";
import { chromium, Browser } from "playwright";

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

function extractImageFromHtml(html?: string, baseUrl?: string): string | undefined {
  if (!html) return undefined;

  function resolveUrl(raw: string): string | undefined {
    if (isHttpUrl(raw)) return raw;
    if (!baseUrl) return undefined;
    try { return new URL(raw, baseUrl).href; } catch { return undefined; }
  }

  // og:image - handle both attribute orderings:
  //   <meta property="og:image" content="...">
  //   <meta content="..." property="og:image">
  const ogPatterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];
  for (const pattern of ogPatterns) {
    const m = html.match(pattern);
    if (m?.[1]) { const r = resolveUrl(m[1]); if (r) return r; }
  }

  // twitter:image - handle both attribute orderings
  const twitterPatterns = [
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']twitter:image["']/i,
  ];
  for (const pattern of twitterPatterns) {
    const m = html.match(pattern);
    if (m?.[1]) { const r = resolveUrl(m[1]); if (r) return r; }
  }

  // Fallback: first <img> with resolvable URL
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img?.[1]) { const r = resolveUrl(img[1]); if (r) return r; }

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

// ── Article page scraping ──────────────────────────────────────────────────────
const PAGE_SCRAPE_CONCURRENCY = 5;
const SCRAPE_READ_LIMIT = 150_000; // 150KB — enough for any news article

interface ScrapedPage {
  image?: string;
  content?: string;
}

// Shared headless browser instance — reused across scrapes to avoid launch overhead
let _browser: Browser | null = null;

async function getHeadlessBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      // Hide Chromium's automation fingerprint so bot-detecting sites don't block us
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }
  return _browser;
}

export async function closeHeadlessBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Extract article text from Next.js __NEXT_DATA__ embedded JSON.
 * Many modern news sites (AP News, Bloomberg, etc.) embed full article HTML/text
 * in a <script id="__NEXT_DATA__"> tag which is present even in plain-fetch HTML.
 */
function extractFromNextData(html: string): string | undefined {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return undefined;
  try {
    const raw = m[1];
    // Ordered by likelihood: AP News uses storyHTML, others use articleBody/body/content
    const fieldPatterns = [
      /"storyHTML"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"(?:body|content|text)"\s*:\s*"((?:[^"\\]|\\.){500,})"/,  // min 500 chars to skip nav strings
    ];
    for (const pattern of fieldPatterns) {
      const cm = raw.match(pattern);
      if (!cm) continue;
      const unescaped = cm[1]
        .replace(/\\n/g, "\n").replace(/\\t/g, " ")
        .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      const text = cleanScrapedText(htmlToText(removeAdLikeHtmlBlocks(unescaped)));
      if (text.split(/\s+/).length >= 100) return text.slice(0, 8000);
    }
  } catch { /* malformed JSON — ignore */ }
  return undefined;
}

// Selectors tried in order when using Playwright DOM extraction
const ARTICLE_SELECTORS = [
  "[data-testid='Body']",           // Reuters
  "[data-gu-name='body']",          // The Guardian
  ".article-body-viewer-selector",  // Guardian (alt)
  ".dcr-1qe8r1m",                   // Guardian dynamic class fallback (innerText still works)
  "[data-component='text-block']",  // Guardian paragraphs
  "article",
  "[class*='ArticleBody']",         // Bloomberg, Forbes
  "[class*='article-body']",
  "[class*='story-body']",
  "[class*='post-content']",
  "[class*='entry-content']",
  "main",
];

const AD_BLOCK_SELECTOR = [
  "aside",
  "iframe",
  "[role='complementary']",
  "[aria-label*='advert' i]",
  "[aria-label*='sponsor' i]",
  "[class*='ad-' i]",
  "[class*='ads-' i]",
  "[class*='advert' i]",
  "[class*='sponsor' i]",
  "[class*='promo' i]",
  "[class*='newsletter' i]",
  "[class*='related' i]",
  "[class*='recirc' i]",
  "[class*='outbrain' i]",
  "[class*='taboola' i]",
  "[id*='ad-' i]",
  "[id*='ads-' i]",
  "[id*='advert' i]",
  "[id*='sponsor' i]",
  "[id*='promo' i]",
  "[data-testid*='ad' i]",
  "[data-testid*='advert' i]",
  "[data-testid*='sponsor' i]",
  "[data-ad]",
  "[data-ad-unit]",
  "[data-ad-slot]",
].join(",");

const AD_LINE_PATTERNS = [
  /^\s*(advertisement|advertiser content|sponsored content|sponsored by|paid post|paid content|partner content)\s*$/i,
  /^\s*(story continues below advertisement|article continues after advertisement|continue reading below|read more below)\s*$/i,
  /^\s*(sign up|subscribe|newsletter|follow us|share this article|listen to this article)\b/i,
  /\b(advertisement|sponsored content|paid post|paid content)\b/i,
  /\b(outbrain|taboola)\b/i,
];

function cleanScrapedText(text: string): string {
  const lines = text
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const cleaned: string[] = [];
  for (const line of lines) {
    if (AD_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    cleaned.push(line);
  }

  return cleaned.join("\n\n").trim();
}

function removeAdLikeHtmlBlocks(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer|aside|figure|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+(?:class|id|aria-label|data-testid|data-component|data-ad|data-ad-unit|data-ad-slot)=["'][^"']*(?:\bad(?:vert|s)?\b|ad-|ads-|sponsor|promo|newsletter|related|recirc|outbrain|taboola)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section|aside|figure|iframe|ul|ol)>/gi, " ");
}

/** Fetch an article page and extract og:image + readable body text.
 *  Tries a plain fetch first (with __NEXT_DATA__ fallback for React sites);
 *  falls back to a headless Chromium page with live DOM extraction for
 *  JS-gated / bot-blocking sites. */
async function scrapeArticlePage(url: string): Promise<ScrapedPage> {
  // Fast path: plain fetch (no browser overhead)
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const reader = res.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (totalBytes < SCRAPE_READ_LIMIT) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalBytes += value.length;
        }
        reader.cancel().catch(() => {});
        const html = new TextDecoder().decode(
          chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }, new Uint8Array())
        );
        const image = extractImageFromHtml(html, url);
        // Try regex extraction first, then __NEXT_DATA__ JSON for React/Next.js sites
        const content = extractArticleText(html) ?? extractFromNextData(html);
        if (content) return { image, content };
        // Content empty — site likely rendered via JS; fall through to browser
      }
    }
  } catch {
    // Network error or timeout — fall through to browser
  }

  // Browser fallback: headless Chromium with live DOM extraction
  try {
    const browser = await getHeadlessBrowser();
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    const page = await context.newPage();
    // Mask navigator.webdriver so anti-bot checks see a regular browser
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

      // Dismiss cookie/GDPR consent popups that gate article content
      await page.evaluate(() => {
        const acceptPatterns = [
          'button[id*="accept"]', 'button[class*="accept"]',
          'button[data-testid*="accept"]', 'button[title*="Accept"]',
          '[class*="consent"] button', '[id*="consent"] button',
          '[class*="cookie"] button', '[id*="cookie"] button',
        ];
        for (const sel of acceptPatterns) {
          const btn = document.querySelector(sel) as HTMLElement | null;
          if (btn) { btn.click(); break; }
        }
      }).catch(() => {});

      // Use browser's own DOM to extract text — far more reliable than regex on
      // JS-rendered HTML (handles shadow DOM, dynamic class names, etc.)
      const domExtract = async (): Promise<string> =>
        page.evaluate(({ selectors, adSelector }: { selectors: string[]; adSelector: string }) => {
          document.querySelectorAll(adSelector).forEach((el) => el.remove());
          for (const sel of selectors) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) continue;
            el.querySelectorAll(adSelector).forEach((child) => child.remove());
            const text = (el.innerText || el.textContent || "").trim();
            if (text.split(/\s+/).filter(Boolean).length >= 100) return text;
          }
          return (document.body?.innerText || "").trim();
        }, { selectors: ARTICLE_SELECTORS, adSelector: AD_BLOCK_SELECTOR }).catch(() => "");

      let domText = cleanScrapedText(await domExtract());

      // If content is thin after domcontentloaded, wait for JS to finish rendering
      if (domText.split(/\s+/).filter(Boolean).length < 100) {
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        domText = cleanScrapedText(await domExtract());
      }

      const html = await page.content();
      const image = extractImageFromHtml(html, url);
      const wordCount = domText.split(/\s+/).filter(Boolean).length;
      const content = wordCount >= 100 ? domText.slice(0, 8000) : (extractArticleText(html) ?? extractFromNextData(html));
      return { image, content };
    } finally {
      await context.close();
    }
  } catch {
    return {};
  }
}

/**
 * Extract the main article text from raw HTML using heuristics.
 * Targets common article container selectors before falling back to <body>.
 */
function extractArticleText(html: string): string | undefined {
  // Strip script/style/nav/header/footer noise
  const stripped = removeAdLikeHtmlBlocks(html);

  // Try known article container patterns
  const containerPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /class="[^"]*(?:article[-_]body|story[-_]body|post[-_]content|entry[-_]content|article[-_]content|main[-_]content)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section|article)>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
  ];

  let best = "";
  for (const pattern of containerPatterns) {
    const m = stripped.match(pattern);
    if (m) {
      const text = cleanScrapedText(htmlToText(m[1] ?? m[0]));
      if (text.length > best.length) best = text;
    }
  }

  // Fallback: strip all tags from body
  if (best.length < 200) {
    const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) best = cleanScrapedText(htmlToText(bodyMatch[1]));
  }

  const trimmed = cleanScrapedText(best).trim();
  // Require at least 100 words to count as real article content
  return trimmed.split(/\s+/).length >= 100 ? trimmed.slice(0, 8000) : undefined;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

/**
 * Enrich articles: fill missing imageUrl AND extract full article content.
 * Skips articles that already have both. Runs PAGE_SCRAPE_CONCURRENCY fetches in parallel.
 */
export async function enrichWithArticleImages(articles: IngestArticle[]): Promise<IngestArticle[]> {
  const needsImage = articles.filter((a) => !a.imageUrl);
  const needsContent = articles.filter((a) => !a.content || a.content.length < 200);
  const needsScrape = articles.filter((a) => !a.imageUrl || !a.content || a.content.length < 200);
  
  console.log(`[enrichArticles] ${articles.length} articles total — need image:${needsImage.length} need content:${needsContent.length} will scrape:${needsScrape.length}`);

  let imagesFound = 0;
  let contentFound = 0;
  let scrapeErrors = 0;

  for (let i = 0; i < needsScrape.length; i += PAGE_SCRAPE_CONCURRENCY) {
    const batch = needsScrape.slice(i, i + PAGE_SCRAPE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const scraped = await scrapeArticlePage(article.url);
        let image = false;
        let content = false;
        if (scraped.image && !article.imageUrl) {
          article.imageUrl = scraped.image;
          image = true;
        }
        if (scraped.content && (!article.content || article.content.length < 200)) {
          article.content = scraped.content;
          content = true;
        }
        return { image, content };
      })
    );
    
    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.image) imagesFound++;
        if (r.value.content) contentFound++;
      } else {
        scrapeErrors++;
      }
    }
    
    // Progress log every 50 articles
    if ((i + PAGE_SCRAPE_CONCURRENCY) % 50 === 0 || i + PAGE_SCRAPE_CONCURRENCY >= needsScrape.length) {
      console.log(`[enrichArticles] progress: ${Math.min(i + PAGE_SCRAPE_CONCURRENCY, needsScrape.length)}/${needsScrape.length} — images:${imagesFound} content:${contentFound} errors:${scrapeErrors}`);
    }
  }

  const finalWithImages = articles.filter((a) => a.imageUrl).length;
  console.log(`[enrichArticles] done — ${finalWithImages}/${articles.length} articles have images (scraped ${imagesFound} new)`);

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

// ── Top Headlines ──────────────────────────────────────────────────────────────
// Fetches real front-page headlines from major news outlets (BBC, Reuters, AP, NPR, etc.)
// These are the stories that would appear on the first page of CNN/BBC/Reuters.

const HEADLINE_FEEDS: Array<{ url: string; name: string }> = [
  { url: "https://feeds.bbci.co.uk/news/rss.xml", name: "BBC News" },
  { url: "https://feeds.reuters.com/reuters/topNews", name: "Reuters" },
  { url: "https://feeds.npr.org/1001/rss.xml", name: "NPR News" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", name: "NYT" },
  { url: "https://www.theguardian.com/world/rss", name: "The Guardian" },
  { url: "https://feeds.skynews.com/feeds/rss/home.xml", name: "Sky News" },
  { url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", name: "Google News Top Stories" },
];

/**
 * Fetch front-page headlines from major outlets.
 * These are the stories a typical news reader would see on CNN/BBC/Reuters today.
 */
export async function fetchTopHeadlines(limit = 30): Promise<IngestArticle[]> {
  const results = await Promise.allSettled(
    HEADLINE_FEEDS.map(async ({ url, name }) => {
      const articles = await fetchOneFeed(url, Math.ceil(limit / HEADLINE_FEEDS.length) + 3);
      return articles.map((a) => ({ ...a, sourceType: "rss" as const, sourceName: name }));
    })
  );

  const all: IngestArticle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }

  // Sort by newest first, dedupe, cap
  return dedupeArticles(all)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit);
}
