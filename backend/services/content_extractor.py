"""
Content extractor for news articles.
Extracts full article content from URLs using the news crawler.
"""
import asyncio
import logging
from typing import Dict, Optional, List
from urllib.parse import urlparse
import tldextract
from googlenewsdecoder import gnewsdecoder
from crawler.news_crawler import resolve_google_news_redirect, crawler, crawler_data, url_map, _crawler_lock
from readability import Document
from bs4 import BeautifulSoup
from langdetect import detect

logger = logging.getLogger(__name__)

def get_base_url(url):
    """Extract base URL from full URL."""
    parsed = urlparse(url)
    ext = tldextract.extract(url)
    return parsed.netloc, f"{ext.domain}.{ext.suffix}"

async def extract_content_from_url(url: str, timeout: int = 30) -> Optional[Dict[str, str]]:
    """
    Extract content from a single news article URL.
    
    Args:
        url: URL of the news article
        timeout: Timeout in seconds
    
    Returns:
        Dictionary with 'content', 'title', and 'image_url', or None if extraction fails
    """
    try:
        original_url = url
        
        # Resolve Google News redirects if needed
        if get_base_url(url)[0] == "news.google.com":
            decoded_url = gnewsdecoder(url)
            if decoded_url.get("status"):
                url = decoded_url["decoded_url"]
            if url is None or get_base_url(url)[0] == "news.google.com":
                try:
                    url = await resolve_google_news_redirect(url)
                except Exception as e:
                    logger.warning(f"Failed to resolve Google News redirect: {e}")
                    return None
        
        # Use a temporary ID for this URL (use both original and resolved)
        temp_id = f"temp_{abs(hash(url))}"
        
        # Store mapping for both URLs
        url_map[url] = temp_id
        if original_url != url:
            url_map[original_url] = temp_id
        
        # Track initial crawler data length
        initial_data_length = 0
        async with _crawler_lock:
            initial_data_length = len(crawler_data)
        
        # Run crawler
        try:
            if crawler._running:
                await crawler.add_requests([url])
            else:
                await crawler.run([url])
        except Exception as e:
            logger.error(f"Crawler error for {url}: {e}")
            if url in url_map:
                del url_map[url]
            if original_url in url_map:
                del url_map[original_url]
            return None
        
        # Wait for crawler to finish (with timeout)
        max_wait = timeout
        wait_interval = 0.5
        waited = 0
        
        while waited < max_wait:
            async with _crawler_lock:
                # Check for new data
                if len(crawler_data) > initial_data_length:
                    # Look for our URL in the new data
                    for item in crawler_data[initial_data_length:]:
                        if item['url'] == url or item['url'] == original_url:
                            # Found the content
                            if url in url_map:
                                del url_map[url]
                            if original_url in url_map:
                                del url_map[original_url]
                            
                            if item.get('available') and item.get('content'):
                                return {
                                    'content': item['content'],
                                    'title': item.get('title', ''),
                                    'image_url': item.get('image_url', '')
                                }
                            else:
                                # Content not available
                                return None
            
            await asyncio.sleep(wait_interval)
            waited += wait_interval
        
        # Timeout - content not extracted
        logger.warning(f"Timeout extracting content from {url}")
        if url in url_map:
            del url_map[url]
        if original_url in url_map:
            del url_map[original_url]
        return None
        
    except Exception as e:
        logger.error(f"Error extracting content from {url}: {e}")
        if url in url_map:
            del url_map[url]
        if original_url in url_map:
            del url_map[original_url]
        return None

async def extract_content_batch(urls: List[str], timeout: int = 30) -> Dict[str, Optional[Dict[str, str]]]:
    """
    Extract content from multiple URLs in batch.
    
    Args:
        urls: List of URLs to extract content from
        timeout: Timeout per URL in seconds
    
    Returns:
        Dictionary mapping URLs to their extracted content (or None if failed)
    """
    results = {}
    
    # Process URLs in smaller batches to avoid overwhelming the crawler
    batch_size = 5
    for i in range(0, len(urls), batch_size):
        batch = urls[i:i + batch_size]
        
        # Extract content for each URL in the batch
        tasks = [extract_content_from_url(url, timeout) for url in batch]
        batch_results = await asyncio.gather(*tasks, return_exceptions=True)
        
        for url, result in zip(batch, batch_results):
            if isinstance(result, Exception):
                logger.error(f"Error extracting content from {url}: {result}")
                results[url] = None
            else:
                results[url] = result
        
        # Small delay between batches
        if i + batch_size < len(urls):
            await asyncio.sleep(1)
    
    return results

def extract_content_sync(url: str, timeout: int = 30) -> Optional[Dict[str, str]]:
    """
    Synchronous wrapper for extract_content_from_url.
    Use this when you need to call from a non-async context.
    """
    try:
        from async_manager import run_async_sync
        return run_async_sync(extract_content_from_url(url, timeout), timeout=timeout + 5)
    except Exception as e:
        logger.error(f"Error in extract_content_sync: {e}")
        return None

