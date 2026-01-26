"""
News Service - Fetches news from Google RSS based on country and language preferences.
No local storage - all news is fetched on-demand from online sources.
"""
import feedparser
import time
import socket
from datetime import datetime, timedelta
from typing import List, Dict, Optional
from urllib.parse import quote
from langdetect import detect
import logging

try:
    from dateutil.parser import parse as date_parse
except ImportError:
    date_parse = None

logger = logging.getLogger(__name__)

# Google News RSS base URL
GOOGLE_NEWS_BASE = "https://news.google.com/rss"

# Country codes mapping
COUNTRY_CODES = {
    "US": "US",
    "CA": "CA", 
    "GB": "GB",
    "UK": "GB",
    "CN": "CN",
    "FR": "FR",
    "GLOBAL": None,  # No country code for global
}

# Language codes mapping
LANGUAGE_CODES = {
    "en": "en",
    "zh": "zh",
    "fr": "fr",
    "es": "es",
    "de": "de",
    "ja": "ja",
}

# Sector/Topic mappings for Google News
SECTOR_TOPICS = {
    "business": "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnpHZ0pEVHlnQVAB",
    "finance": "CAAqIQgKIhtDQkFTRGdvSUwyMHZNREpmTjNRU0FtVnVLQUFQAQ",
    "economy": "CAAqIQgKIhtDQkFTRGdvSUwyMHZNREpxTmpJU0FtVnVLQUFQAQ",
    "tech": "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB",
    "science": "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pWVXlnQVAB",
    "health": "CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ",
    "sports": "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB",
    "entertainment": "CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB",
    "politics": "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB",
    "general": None,  # Top stories
}

def detect_news_url(url: str) -> bool:
    """Filter out non-news URLs."""
    keywords = ["sign-up", "signup", "sign-in", "signin", "register", "login", "log-in"]
    boring_keywords = ["about", "contact", "cookie", "privacy", "terms", "faq", "sitemap"]
    media_paths = ["video", "videos", "audio", "audios", "media", "playlist", "vod", "stream"]
    non_text_extensions = (".mp4", ".mp3", ".avi", ".mov", ".wav", ".ogg", ".webm", ".flac", ".jpg", ".png", ".gif", ".pdf")

    url_lower = url.lower()
    if any(keyword in url_lower for keyword in keywords):
        return False
    if url_lower.endswith(non_text_extensions):
        return False
    if any(f"/{mp}/" in url_lower or url_lower.endswith(f"/{mp}") for mp in boring_keywords):
        return False
    if any(f"/{mp}/" in url_lower or url_lower.endswith(f"/{mp}") for mp in media_paths):
        return False
    return True

def build_google_news_url(
    country: Optional[str] = None,
    language: str = "en",
    query: Optional[str] = None,
    topic: Optional[str] = None
) -> str:
    """
    Build Google News RSS URL based on parameters.
    
    Args:
        country: Country code (US, CA, GB, etc.) or None for global
        language: Language code (en, zh, fr, etc.)
        query: Search query string
        topic: Topic ID from Google News (for sectors)
    
    Returns:
        Google News RSS URL
    """
    if query:
        # Search query
        encoded_query = quote(query)
        url = f"{GOOGLE_NEWS_BASE}/search?q={encoded_query}"
        if country and country in COUNTRY_CODES:
            url += f"&hl={language}&gl={COUNTRY_CODES[country]}"
        else:
            url += f"&hl={language}"
        return url
    
    if topic:
        # Topic-based feed
        url = f"{GOOGLE_NEWS_BASE}/topics/{topic}"
        if country and country in COUNTRY_CODES:
            url += f"?hl={language}&gl={COUNTRY_CODES[country]}"
        else:
            url += f"?hl={language}"
        return url
    
    # Top stories
    if country and country in COUNTRY_CODES:
        url = f"{GOOGLE_NEWS_BASE}?hl={language}&gl={COUNTRY_CODES[country]}"
    else:
        url = f"{GOOGLE_NEWS_BASE}?hl={language}"
    
    return url

def parse_feed_entry(entry) -> Optional[Dict]:
    """Parse a single RSS feed entry into a news item."""
    try:
        # Safely get title and link
        title = entry.get("title", "") if hasattr(entry, "get") else getattr(entry, "title", "")
        link = entry.get("link", "") if hasattr(entry, "get") else getattr(entry, "link", "")
        
        # Validate title and link
        if not title or not link:
            return None
        
        # Check title length (at least 5 words)
        title_words = title.split()
        if len(title_words) <= 4:
            return None
        
        # Detect language - be more lenient with detection failures
        try:
            lang = detect(title)
            if lang and not lang.startswith("en"):
                return None
        except Exception as e:
            # If language detection fails, log but continue (might be valid English)
            logger.debug(f"Language detection failed for title '{title[:50]}...': {e}")
            # Continue processing - assume it might be English
        
        # Validate URL
        if not detect_news_url(link):
            return None
        
        # Parse published date with better error handling
        published_at = time.time()  # Default to current time
        try:
            published_parsed = entry.get("published_parsed") if hasattr(entry, "get") else getattr(entry, "published_parsed", None)
            if published_parsed:
                try:
                    published_at = time.mktime(published_parsed)
                except (ValueError, OverflowError, OSError) as e:
                    logger.debug(f"Error converting published_parsed to timestamp: {e}")
                    # Try to parse from published string
                    try:
                        published_str = entry.get("published", "") if hasattr(entry, "get") else getattr(entry, "published", "")
                        if published_str and date_parse:
                            dt = date_parse(published_str)
                            published_at = dt.timestamp()
                    except:
                        pass  # Use default current time
        except Exception as e:
            logger.debug(f"Error parsing published date: {e}")
        
        # Filter out old news (older than 48 hours)
        if published_at < time.time() - 48 * 60 * 60:
            return None
        
        # Get image URL with better error handling
        image_url = ""
        try:
            if hasattr(entry, "media_thumbnail") and entry.media_thumbnail:
                if isinstance(entry.media_thumbnail, list) and len(entry.media_thumbnail) > 0:
                    thumb = entry.media_thumbnail[0]
                    if hasattr(thumb, "get"):
                        image_url = thumb.get("url", "")
                    elif hasattr(thumb, "url"):
                        image_url = thumb.url
        except Exception as e:
            logger.debug(f"Error extracting image URL: {e}")
        
        # Get or create podcast ID in database
        news_id = None
        try:
            from db.db import get_podcast_by_link, create_podcast
            # Check if news item already exists in database
            existing_id = get_podcast_by_link(link)
            if existing_id:
                news_id = existing_id
            else:
                # Try to create a lightweight podcast entry (without content/audio) so client has an ID
                # But skip if embedding model is not available (common in MCP server context)
                try:
                    podcast_data = {
                        "image_url": image_url,
                        "content_url": "",
                        "audio_url": "",
                        "transcript_url": "",
                        "duration": 0,
                        "fetched_at": 0
                    }
                    news_id = create_podcast(
                        title=title,
                        link=link,
                        published_at=published_at,
                        podcast=podcast_data,
                        daily=None
                    )
                except (AttributeError, TypeError, Exception) as e:
                    # If embedding model is not initialized (bge_m3_ef is None), skip creation
                    # This is expected in MCP server context where CUDA models may not be loaded
                    error_str = str(e)
                    if "encode_documents" in error_str or "NoneType" in error_str or "bge_m3_ef" in error_str:
                        logger.debug(f"Skipping podcast creation (embedding model not available): {link}")
                        news_id = None
                    else:
                        # Re-raise if it's a different error
                        raise
        except Exception as e:
            logger.debug(f"Error getting/creating podcast ID for {link}: {e}")
            # Continue without ID if database operation fails
        
        return {
            "id": news_id,  # May be None if not in database
            "title": title,
            "link": link,
            "image_url": image_url,
            "published_at": published_at,
            "published": entry.get("published", "") if hasattr(entry, "get") else getattr(entry, "published", ""),
        }
    except Exception as e:
        logger.error(f"Error parsing feed entry: {e}")
        return None

def fetch_news_from_rss(
    country: Optional[str] = None,
    language: str = "en",
    query: Optional[str] = None,
    sector: Optional[str] = None,
    limit: int = 20,
    max_retries: int = 3,
    extract_content: bool = False
) -> List[Dict]:
    """
    Fetch news from Google RSS.
    
    Args:
        country: Country code (US, CA, GB, etc.) or None for global
        language: Language code (en, zh, fr, etc.)
        query: Search query string
        sector: News sector (business, finance, tech, etc.)
        limit: Maximum number of news items to return
        max_retries: Maximum number of retry attempts
        extract_content: If True, also fetch full article content (slower)
    
    Returns:
        List of news items (with 'content' field if extract_content=True)
    """
    # Get topic ID if sector is provided
    topic = None
    if sector and sector.lower() in SECTOR_TOPICS:
        topic = SECTOR_TOPICS[sector.lower()]
    
    # Build RSS URL
    rss_url = build_google_news_url(
        country=country,
        language=language,
        query=query,
        topic=topic
    )
    
    logger.info(f"Fetching news from: {rss_url}")
    
    # Retry logic with exponential backoff
    last_error = None
    for attempt in range(max_retries):
        try:
            # Set timeout per request (not globally)
            old_timeout = socket.getdefaulttimeout()
            socket.setdefaulttimeout(15)  # 15 second timeout
            
            try:
                # Parse feed
                feed = feedparser.parse(rss_url)
            finally:
                # Restore original timeout
                socket.setdefaulttimeout(old_timeout)
            
            if feed.bozo and feed.bozo_exception:
                error_msg = str(feed.bozo_exception)
                logger.warning(f"RSS feed parse warning (attempt {attempt + 1}/{max_retries}): {error_msg}")
                # Some bozo exceptions are warnings, not fatal errors
                if "not well-formed" in error_msg.lower() or "not well formed" in error_msg.lower():
                    # If it's a malformed XML error, retry
                    if attempt < max_retries - 1:
                        time.sleep(2 ** attempt)  # Exponential backoff
                        continue
                    else:
                        logger.error(f"Failed to parse RSS feed after {max_retries} attempts: {error_msg}")
                        return []
            
            # Parse entries
            news_items = []
            entries_to_check = feed.entries[:limit * 3] if hasattr(feed, 'entries') else []  # Get more entries to account for filtering
            
            for entry in entries_to_check:
                news_item = parse_feed_entry(entry)
                if news_item:
                    news_items.append(news_item)
                    if len(news_items) >= limit:
                        break
            
            logger.info(f"Fetched {len(news_items)} news items")
            
            # Extract content if requested
            if extract_content and news_items:
                logger.info(f"Extracting content for {len(news_items)} articles...")
                try:
                    from services.content_extractor import extract_content_batch
                    import asyncio
                    
                    urls = [item['link'] for item in news_items]
                    content_results = asyncio.run(extract_content_batch(urls, timeout=30))
                    
                    # Add content to news items
                    for item in news_items:
                        url = item['link']
                        if url in content_results and content_results[url]:
                            content_data = content_results[url]
                            item['content'] = content_data.get('content', '')
                            # Update image_url if we got a better one from content extraction
                            if content_data.get('image_url') and not item.get('image_url'):
                                item['image_url'] = content_data.get('image_url', '')
                        else:
                            item['content'] = ''  # Empty content if extraction failed
                    
                    logger.info(f"Content extraction completed for {len([r for r in content_results.values() if r])} articles")
                except Exception as e:
                    logger.error(f"Error extracting content: {e}")
                    # Add empty content field to all items if extraction fails
                    for item in news_items:
                        item['content'] = ''
            
            return news_items
            
        except socket.timeout:
            last_error = f"Timeout error (attempt {attempt + 1}/{max_retries})"
            logger.warning(last_error)
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)  # Exponential backoff
                continue
        except Exception as e:
            last_error = f"Error fetching news (attempt {attempt + 1}/{max_retries}): {str(e)}"
            logger.warning(last_error)
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)  # Exponential backoff
                continue
            else:
                logger.error(f"Failed to fetch news after {max_retries} attempts: {e}")
                return []
    
    logger.error(f"Failed to fetch news: {last_error}")
    return []

def search_news(query: str, country: Optional[str] = None, language: str = "en", limit: int = 20, extract_content: bool = False) -> List[Dict]:
    """
    Search for news using a query string.
    
    Args:
        query: Search query
        country: Country code (optional)
        language: Language code (default: en)
        limit: Maximum number of results
    
    Returns:
        List of news items
    """
    return fetch_news_from_rss(
        country=country,
        language=language,
        query=query,
        limit=limit,
        extract_content=extract_content
    )

def get_todays_news(
    country: Optional[str] = None,
    language: str = "en",
    sector: Optional[str] = None,
    limit: int = 20,
    extract_content: bool = False
) -> List[Dict]:
    """
    Get today's top news.
    
    Args:
        country: Country code (optional)
        language: Language code (default: en)
        sector: News sector (optional) - if not provided, returns top news overall
        limit: Maximum number of results
    
    Returns:
        List of news items
    """
    return fetch_news_from_rss(
        country=country,
        language=language,
        sector=sector,
        limit=limit,
        extract_content=extract_content
    )

def get_financial_news(
    country: Optional[str] = None,
    language: str = "en",
    limit: int = 20,
    extract_content: bool = False
) -> List[Dict]:
    """
    Get financial/macro economic news.
    
    Args:
        country: Country code (optional)
        language: Language code (default: en)
        limit: Maximum number of results
    
    Returns:
        List of financial news items
    """
    return fetch_news_from_rss(
        country=country,
        language=language,
        sector="finance",
        limit=limit,
        extract_content=extract_content
    )

def get_company_news(
    company_name: str,
    country: Optional[str] = None,
    language: str = "en",
    limit: int = 20,
    extract_content: bool = False
) -> List[Dict]:
    """
    Get news for a specific company.
    
    Args:
        company_name: Name of the company
        country: Country code (optional)
        language: Language code (default: en)
        limit: Maximum number of results
    
    Returns:
        List of news items about the company
    """
    query = f"{company_name} stock OR {company_name} earnings OR {company_name} news"
    return search_news(
        query=query,
        country=country,
        language=language,
        limit=limit,
        extract_content=extract_content
    )

