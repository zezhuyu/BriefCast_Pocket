"""
Quick news updater - Fetches news from Google RSS and stores in database.
"""
import threading
import time
import logging
from typing import Optional, List, Dict

from services.news_service import (
    get_todays_news,
    search_news,
    get_financial_news
)
from db.db import create_podcast, get_user_preferences

logger = logging.getLogger(__name__)

def update_news_from_google(
    user_id: Optional[str] = None,
    country: Optional[str] = None,
    language: str = "en",
    sectors: Optional[List[str]] = None,
    limit_per_sector: int = 20
) -> Dict[str, int]:
    """
    Fetch news from Google RSS and store in database.
    
    Args:
        user_id: User ID to get preferences from (optional)
        country: Country code override (optional)
        language: Language code (default: en)
        sectors: List of sectors to fetch (default: ['general', 'tech', 'business', 'finance'])
        limit_per_sector: Number of news items per sector
    
    Returns:
        Dictionary with counts of news items fetched per sector
    """
    # Get user preferences if user_id provided
    if user_id and not country:
        prefs = get_user_preferences(user_id)
        if prefs:
            country = country or prefs.get("country")
            language = language or prefs.get("language", "en")
    
    # Default sectors if not provided
    if sectors is None:
        sectors = ['general', 'tech', 'business', 'finance']
    
    results = {}
    total_fetched = 0
    
    logger.info(f"Starting news update from Google RSS (country={country}, language={language})")
    
    for sector in sectors:
        try:
            logger.info(f"Fetching {sector} news...")
            
            # Fetch news based on sector
            if sector == 'finance':
                news_items = get_financial_news(
                    country=country,
                    language=language,
                    limit=limit_per_sector
                )
            elif sector == 'general':
                news_items = get_todays_news(
                    country=country,
                    language=language,
                    sector=None,  # Top stories
                    limit=limit_per_sector
                )
            else:
                news_items = get_todays_news(
                    country=country,
                    language=language,
                    sector=sector,
                    limit=limit_per_sector
                )
            
            # Store news items in database
            stored_count = 0
            for item in news_items:
                try:
                    podcast_data = {
                        "image_url": item.get("image_url", ""),
                        "content_url": "",
                        "audio_url": "",
                        "transcript_url": "",
                        "duration": 0,
                        "fetched_at": 0
                    }
                    
                    pid = create_podcast(
                        title=item.get("title", ""),
                        link=item.get("link", ""),
                        published_at=item.get("published_at", time.time()),
                        podcast=podcast_data,
                        daily=None
                    )
                    
                    if pid:
                        stored_count += 1
                        total_fetched += 1
                
                except Exception as e:
                    logger.error(f"Error storing news item '{item.get('title', '')[:50]}...': {e}")
                    continue
            
            results[sector] = stored_count
            logger.info(f"Stored {stored_count} {sector} news items")
            
            # Small delay between sectors to avoid rate limiting
            time.sleep(1)
        
        except Exception as e:
            logger.error(f"Error fetching {sector} news: {e}")
            results[sector] = 0
    
    logger.info(f"News update completed. Total items stored: {total_fetched}")
    return {
        "total": total_fetched,
        "by_sector": results
    }

def update_news_async(
    user_id: Optional[str] = None,
    country: Optional[str] = None,
    language: str = "en",
    sectors: Optional[List[str]] = None,
    limit_per_sector: int = 20
):
    """
    Update news asynchronously in a background thread.
    """
    def update_task():
        try:
            update_news_from_google(
                user_id=user_id,
                country=country,
                language=language,
                sectors=sectors,
                limit_per_sector=limit_per_sector
            )
        except Exception as e:
            logger.error(f"Error in background news update: {e}")
    
    thread = threading.Thread(target=update_task, daemon=True)
    thread.start()
    return thread

