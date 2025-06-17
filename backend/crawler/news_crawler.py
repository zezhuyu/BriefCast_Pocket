import sys
import os
import asyncio
from crawlee.crawlers import BeautifulSoupCrawler, BeautifulSoupCrawlingContext
from crawlee.storages import Dataset
from crawlee.configuration import Configuration
from readability import Document
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from dateutil.parser import parse
from urllib.parse import urlparse
import tldextract
import time
import gc
from dateutil.parser import parse
from datetime import datetime
import spacy
from urllib.parse import urljoin
from collections import Counter
from geopy.geocoders import Nominatim
from langdetect import detect
from googlenewsdecoder import gnewsdecoder
from playwright.async_api import async_playwright
from db.db import get_podcast_by_link, store_podcast_content, update_podcast_image, get_podcast_content, update_podcast_fetched_at, get_podcast_fetched_time
from db.cache import store

crawler = crawler = BeautifulSoupCrawler(
            configuration=Configuration(
                persist_storage=False,
                purge_on_start=True,
                log_level="CRITICAL"
            )
        )
@crawler.router.default_handler
async def request_handler(context: BeautifulSoupCrawlingContext) -> None:
    soup = context.soup
    html = soup.prettify()
    doc = Document(html)
    article_html = doc.summary()
    title = doc.title()
    bs4_soup = BeautifulSoup(article_html, "html.parser")
    content = bs4_soup.get_text(separator="\n", strip=True)
    heavy_media = is_media_heavy(soup)

    available = True

    if title == "" or title is None or len(title.split()) <= 4:
        available = False
        content = ""
    
    if len(content.split()) <= 100:
        available = False
        content = ""    
    
    if heavy_media:
        available = False
        content = ""
    
    if content != "":
        lang = detect(content)

        if not lang.startswith("en"):
            available = False

    image_url = get_image_url(soup, context.request.url)
    if context.request.url in url_map:
        pid = url_map[context.request.url]
        if pid is not None and available:
            store_podcast_content(pid, content)
        elif pid is not None and not available:
            update_podcast_fetched_at(pid)
        if image_url is not None and image_url != "":
            update_podcast_image(pid, image_url)
        
    data = {
        "available": available,
        'url': context.request.url,
        'title': title,
        'content': content,
        'image_url': get_image_url(soup, context.request.url),
    }
    async with _crawler_lock:
        crawler_data.append(data)
    # await dataset.push_data(data)
            
    return

@crawler.failed_request_handler
async def failed_handler(context: BeautifulSoupCrawlingContext, error: Exception) -> None:
    pass

@crawler.error_handler
async def error_handler(error: Exception, context: BeautifulSoupCrawlingContext) -> None:
    pass

crawler_data = []
url_map = {}

# dataset = asyncio.run(Dataset.open())
_crawler_lock = asyncio.Lock()

async def resolve_google_news_redirect(url):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto(url, wait_until="load")
        await page.wait_for_timeout(1000)
        final_url = page.url
        await browser.close()
        return final_url

def is_media_heavy(soup):
    media_tags = soup.find_all(["video", "audio", "iframe", "code"])
    visible_text = soup.get_text(separator="\n", strip=True)
    return len(media_tags) > 2 or len(visible_text.split()) < 100


def get_base_url(url):
    parsed = urlparse(url)
    ext = tldextract.extract(url)
    l1 = f"{ext.domain}.{ext.suffix}"

    return parsed.netloc, l1

def extract_visible_publish_date(soup):
    meta_tags = [
        {"property": "article:published_time"},
        {"name": "pubdate"},
        {"name": "date"}, 
    ]

    for tag in meta_tags:
        meta = soup.find("meta", attrs=tag)
        if meta and meta.get("content"):
            return meta["content"]

    for time_tag in soup.find_all("time"):
        if time_tag.get("datetime"):
            return time_tag["datetime"]
        
    text = soup.get_text(separator="\n", strip=True)
    lines = text.splitlines()
    keywords = ["published", "posted", "updated", "date"]

    for i, line in enumerate(lines):
        if any(kw in line.lower() for kw in keywords):
            # Try the next 1-2 lines for a date
            for offset in range(1, 3):
                if i + offset < len(lines):
                    try:
                        dt = parse(lines[i + offset], fuzzy=True)
                        return dt
                    except:
                        continue
    return None

def normalize_to_timestamp(time_value):
    if time_value is None:
        return time.time()
    
    if isinstance(time_value, (int, float)):
        return float(time_value)

    if isinstance(time_value, datetime):
        return time_value.timestamp()

    if isinstance(time_value, str):
        try:
            if time_value.endswith("Z"):
                time_value = time_value.replace("Z", "+00:00")
            dt = parse(time_value)
            return dt.timestamp()
        except Exception as e:
            raise ValueError(f"Invalid time string: {time_value!r}") from e

    raise TypeError(f"Unsupported time type: {type(time_value).__name__}")

def detect_news_url(url):
    keywords = ["sign-up", "signup", "sign-in", "signin", "register", "login", "log-in"]
    boring_keywords = ["about", "contact", "cookie", "privacy", "terms", "faq", "sitemap", "usingthebbc"]
    media_paths = ["video", "videos", "audio", "audios", "media", "playlist", "vod", "stream", "livestream", "watch", "player", "api", "apis", "podcast", "podcasts"]
    non_text_extensions = (".mp4", ".mp3", ".avi", ".mov", ".wav", ".ogg", ".webm", ".flac", ".jpg", ".png", ".gif", ".pdf")

    if any(keyword in url.lower() for keyword in keywords):
        return False
    if url.lower().endswith(non_text_extensions):
        return False
    if any(f"/{mp}/" in url.lower() or url.lower().endswith(f"/{mp}") for mp in boring_keywords):
        return False
    if any(f"/{mp}/" in url.lower() or url.lower().endswith(f"/{mp}") for mp in media_paths):
        return False
    return True

def get_image_url(soup, url):
    images = []
    og_image = soup.find('meta', property='og:image')
    if og_image:
        if og_image.get('content').startswith("http"):
            return og_image.get('content')
        else:
            return urljoin(url, og_image.get('content'))
    twitter_image = soup.find('meta', attrs={'name': 'twitter:image'})
    if twitter_image and twitter_image.get('content'):
        if twitter_image.get('content').startswith("http"):
            return twitter_image.get('content')
        else:
            return urljoin(url, twitter_image.get('content'))
    for selector in ['article img', '.main-content img', '.entry-content img', 'img']:
        img = soup.select_one(selector)
        if img and img.get('src'):
            if img.get('src').startswith("http"):
                return img.get('src')
            else:
                return urljoin(url, img.get('src'))
    for div in soup.find_all('div'):
        style = div.get('style', '')
        if 'background-image' in style:
            start = style.find("url(")
            end = style.find(")", start)
            if start != -1 and end != -1:
                img_url = style[start + 4:end].strip('"\'')
                if img_url.startswith("http"):
                    return img_url
                else:
                    return urljoin(url, img_url)
            
    return None

async def news_crawler(entries, find=-1) -> None:
    global crawler, url_map, crawler_data
    
    links = []
    pids = set()
    for entry in entries:
        if find > 0 and len(pids) >= find:
            break
        link = entry['link']
        fetched_at = get_podcast_fetched_time(entry['id'])
        try:
            dt = datetime.strptime(fetched_at, "%Y-%m-%d %H:%M:%S.%f")
        except ValueError:
            dt = datetime.strptime(fetched_at, "%Y-%m-%d %H:%M:%S")
        timestamp_float = dt.timestamp()
        if get_podcast_content(entry['id']) is not None and get_podcast_content(entry['id']) != "":
            pids.add(entry['id'])
            continue
        if timestamp_float > 0:
            continue
        if store.sismember("crawler", entry['id']):
            continue
        links.append({"link": link, "id": entry['id']})
        store.sadd("crawler", entry['id'])
    if find > 0 and len(pids) > find:
        return list(pids)[:find]
    elif find == -1:
        find = len(links)
    if len(links) == 0:
        return list(pids)[:min(len(pids), find)]
    fetched = 0
    for i in range(0, len(links), find):
        ava_links = []
        for link in links[i:i+find]:
            if get_base_url(link['link'])[0] == "news.google.com":
                decoded_url = gnewsdecoder(link['link'])
                if decoded_url.get("status"):
                    link['link'] = decoded_url["decoded_url"]
                if link['link'] is None or get_base_url(link['link'])[0] == "news.google.com":
                    try:
                        link['link'] = await resolve_google_news_redirect(link['link'])
                    except:
                        continue
            url_map[link['link']] = link['id']
            ava_links.append(link['link'])
        try:
            if crawler._running:
                await crawler.add_requests(ava_links)
            else:
                await crawler.run(ava_links)
        except Exception as e:
            print("Crawler error", e)
        gc.collect()
        tmp_crawler_data = []
        async with _crawler_lock:
            while len(crawler_data) > 0:
                item = crawler_data.pop(0)
                if item['url'] in url_map:
                    pid = url_map[item['url']]
                    del url_map[item['url']]
                    if pid is not None and item['available']:
                        # store_podcast_content(pid, item['content'])
                        fetched += 1
                        pids.add(pid)
                        store.srem("crawler", pid)
                    # elif pid is not None and not item['available']:
                    #     update_podcast_fetched_at(pid)
                    # if item['image_url'] is not None and item['image_url'] != "":
                    #     update_podcast_image(pid, item['image_url'])
                else:
                    tmp_crawler_data.append(item)
        async with _crawler_lock:
            crawler_data.extend(tmp_crawler_data)
        if fetched >= find:
            break
    gc.collect()
    return list(pids)[:min(len(pids), find)]

