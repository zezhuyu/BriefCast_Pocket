/**
 * Standalone scraper smoke-test — mirrors production scrapeArticlePage logic.
 * Run with:  npx tsx test-scraper.ts
 */

import { chromium, type Browser } from "playwright";

const SCRAPE_READ_LIMIT = 150_000;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface ScrapedPage {
  image?: string;
  content?: string;
  via?: "fetch" | "fetch+nextdata" | "playwright-dom" | "playwright-dom+networkidle" | "playwright-regex";
}

let _browser: Browser | null = null;
async function getHeadlessBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }
  return _browser;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s{3,}/g, "\n\n").trim();
}

function extractImageFromHtml(html?: string, baseUrl?: string): string | undefined {
  if (!html) return undefined;
  const resolveUrl = (raw: string) => {
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    if (!baseUrl) return undefined;
    try { return new URL(raw, baseUrl).href; } catch { return undefined; }
  };
  for (const p of [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ]) {
    const m = html.match(p);
    if (m?.[1]) { const r = resolveUrl(m[1]); if (r) return r; }
  }
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img?.[1]) { const r = resolveUrl(img[1]); if (r) return r; }
  return undefined;
}

function extractArticleText(html: string): string | undefined {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<figure[\s\S]*?<\/figure>/gi, " ");

  const patterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /class="[^"]*(?:article[-_]body|story[-_]body|post[-_]content|entry[-_]content|article[-_]content|main[-_]content)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section|article)>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
  ];

  let best = "";
  for (const p of patterns) {
    const m = stripped.match(p);
    if (m) { const t = htmlToText(m[1] ?? m[0]); if (t.length > best.length) best = t; }
  }
  if (best.length < 200) {
    const bm = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bm) best = htmlToText(bm[1]);
  }
  const trimmed = best.trim();
  return trimmed.split(/\s+/).length >= 100 ? trimmed.slice(0, 8000) : undefined;
}

function extractFromNextData(html: string): string | undefined {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return undefined;
  try {
    const raw = m[1];
    const fieldPatterns = [
      /"storyHTML"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"(?:body|content|text)"\s*:\s*"((?:[^"\\]|\\.){500,})"/,
    ];
    for (const pattern of fieldPatterns) {
      const cm = raw.match(pattern);
      if (!cm) continue;
      const unescaped = cm[1].replace(/\\n/g, "\n").replace(/\\t/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      const text = htmlToText(unescaped);
      if (text.split(/\s+/).length >= 100) return text.slice(0, 8000);
    }
  } catch {}
  return undefined;
}

const ARTICLE_SELECTORS = [
  "[data-testid='Body']",
  "[data-gu-name='body']",
  ".article-body-viewer-selector",
  "[data-component='text-block']",
  "article",
  "[class*='ArticleBody']",
  "[class*='article-body']",
  "[class*='story-body']",
  "[class*='post-content']",
  "[class*='entry-content']",
  "main",
];

async function scrapeArticlePage(url: string): Promise<ScrapedPage> {
  // Fast path
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
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
          chunks.push(value); totalBytes += value.length;
        }
        reader.cancel().catch(() => {});
        const html = new TextDecoder().decode(chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }, new Uint8Array()));
        const image = extractImageFromHtml(html, url);
        const regexContent = extractArticleText(html);
        if (regexContent) return { image, content: regexContent, via: "fetch" };
        const nextContent = extractFromNextData(html);
        if (nextContent) return { image, content: nextContent, via: "fetch+nextdata" };
      }
    }
  } catch { /* fall through */ }

  // Playwright fallback
  try {
    const browser = await getHeadlessBrowser();
    const context = await browser.newContext({ userAgent: BROWSER_UA, extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      // Dismiss cookie/GDPR popups that gate article content
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

      const domExtract = async (): Promise<string> =>
        page.evaluate((sels: string[]) => {
          for (const sel of sels) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) continue;
            const text = (el.innerText || el.textContent || "").trim();
            if (text.split(/\s+/).filter(Boolean).length >= 100) return text;
          }
          return (document.body?.innerText || "").trim();
        }, ARTICLE_SELECTORS).catch(() => "");

      let domText = await domExtract();
      let via: ScrapedPage["via"] = "playwright-dom";

      if (domText.split(/\s+/).filter(Boolean).length < 100) {
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        domText = await domExtract();
        via = "playwright-dom+networkidle";
      }

      const html = await page.content();
      const image = extractImageFromHtml(html, url);
      const wordCount = domText.split(/\s+/).filter(Boolean).length;

      if (wordCount >= 100) return { image, content: domText.slice(0, 8000), via };
      const content = extractArticleText(html) ?? extractFromNextData(html);
      return { image, content, via: "playwright-regex" };
    } finally {
      await context.close();
    }
  } catch { return {}; }
}

// ── Fetch a real article URL from an RSS feed ─────────────────────────────────
async function followRedirect(url: string): Promise<string> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, redirect: "follow", signal: AbortSignal.timeout(8000) });
    return r.url !== url ? r.url : url;
  } catch { return url; }
}

async function getFirstRssArticleUrl(feedUrl: string): Promise<string | null> {
  try {
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": BROWSER_UA, "Accept": "application/rss+xml, application/xml, text/xml, */*" },
      signal: AbortSignal.timeout(8000),
    });
    const xml = await res.text();

    // Extract links that appear INSIDE <item> blocks only (avoids channel-level <link>)
    const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
    for (const item of itemBlocks) {
      // Try <link> inside item (Google News uses https://news.google.com/rss/articles/... links)
      const linkMatch = item.match(/<link>\s*(https?:\/\/[^<\s]+)\s*<\/link>/i)
        ?? item.match(/<link[^>]+href=["'](https?:\/\/[^"']+)["']/i);
      if (linkMatch) {
        const url = linkMatch[1].trim();
        // Google News redirect URLs — follow to get the real article
        if (url.includes("news.google.com/rss/articles")) return followRedirect(url);
        // Skip obvious homepage/section links
        if (url.split("/").length > 4) return url;
      }
      // Fallback: <guid> with isPermaLink="true" or absolute URL
      const guidMatch = item.match(/<guid[^>]*isPermaLink="true"[^>]*>(https?:\/\/[^<]+)<\/guid>/i)
        ?? item.match(/<guid[^>]*>(https?:\/\/(?!news\.google)[^<]+)<\/guid>/i);
      if (guidMatch && guidMatch[1].split("/").length > 4) return guidMatch[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

type TestCase = {
  label: string;
  url?: string;
  rssFeed?: string;
  expectContent: boolean;
};

const TESTS: TestCase[] = [
  // Direct articles — should work via fetch or playwright-dom
  { label: "AP News",               url: "https://apnews.com/article/trump-tariffs-trade-war-economy-aa8f36fc04e32f42b5ced7c7ddaef598", expectContent: true },
  { label: "Washington Post",       url: "https://www.washingtonpost.com/technology/", expectContent: true },
  { label: "Reuters (hard-blocked)", url: "https://www.reuters.com/technology/artificial-intelligence/openai-said-be-developing-social-media-platform-2025-05-02/", expectContent: false },

  // RSS feeds — extracts a fresh article URL then scrapes it
  { label: "BBC RSS",                rssFeed: "https://feeds.bbci.co.uk/news/world/rss.xml",                  expectContent: true },
  { label: "Yahoo Finance RSS",      rssFeed: "https://finance.yahoo.com/news/rssindex",                      expectContent: true },
  { label: "Google News RSS",        rssFeed: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",        expectContent: true },
  { label: "NPR RSS",                rssFeed: "https://feeds.npr.org/1001/rss.xml",                           expectContent: true },
  { label: "TechCrunch RSS",         rssFeed: "https://techcrunch.com/feed/",                                 expectContent: true },
];

async function runTest(t: TestCase): Promise<void> {
  let url = t.url ?? null;

  if (!url && t.rssFeed) {
    process.stdout.write(`\n${"─".repeat(60)}\n⟳  ${t.label} — fetching RSS for article URL…\n`);
    url = await getFirstRssArticleUrl(t.rssFeed);
    if (!url) {
      console.log(`✗  ${t.label}: could not extract article URL from RSS`);
      return;
    }
    console.log(`   RSS article → ${url}`);
  }

  const start = Date.now();
  let result: ScrapedPage = {};
  let error: string | undefined;
  try {
    result = await scrapeArticlePage(url!);
  } catch (e) {
    error = String(e);
  }

  const ms = Date.now() - start;
  const words = result.content ? result.content.split(/\s+/).filter(Boolean).length : 0;
  const ok = !t.expectContent || words >= 100;

  if (!t.url) console.log(""); else console.log(`\n${"─".repeat(60)}`);
  console.log(`${ok ? "✓" : "✗"} ${t.label}  [${ms}ms, via=${result.via ?? "none"}]`);
  if (error) {
    console.log(`  ERROR: ${error}`);
  } else {
    console.log(`  Image:   ${result.image ?? "(none)"}`);
    console.log(`  Words:   ${words}${words < 100 && t.expectContent ? "  ← TOO FEW" : ""}`);
    console.log(`  Preview: ${result.content?.slice(0, 180).replace(/\n/g, " ") ?? "(no content)"}`);
  }
}

(async () => {
  console.log("BriefCast scraper smoke-test\n");
  for (const t of TESTS) await runTest(t);
  if (_browser) await _browser.close();
  console.log(`\n${"─".repeat(60)}\nDone.`);
})();
