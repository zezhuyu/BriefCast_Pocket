import asyncio
import schedule
import logging
import traceback
from db.files import delete_file
from db.db import delete_empty_or_expired_podcasts, update_prevday_embedding, flush_milvus, get_all_user_id, refresh_db_connections
from crawler.rss import get_all_link
from daily import store_daily_news
from db.cache import store
import requests
import time
from cuda_stuff import clear_cache
from async_manager import safe_async_run

logger = logging.getLogger(__name__)

def get_lat_lng():
    response = requests.get("https://ipinfo.io/json")
    if response.status_code == 200:
        loc = response.json().get("loc")
        if loc:
            latitude, longitude = loc.split(",")
            return float(latitude), float(longitude)
    return None, None

def on_expire_event(msg):
    if msg.get('value', None) is not None and isinstance(msg['value'], dict):
        transcript_url = msg['value'].get("transcript_url", None)
        audio_url = msg['value'].get("audio_url", None)
        delete_file(transcript_url)
        delete_file(audio_url)

def update_daily_vector_for_all_user():
    try:
        user_ids = get_all_user_id()
        if not user_ids:
            return
        for user_id in user_ids:
            try:
                update_prevday_embedding(user_id)
            except Exception as e:
                logger.error(f"Error updating daily vector for user {user_id}: {e}")
                logger.error(traceback.format_exc())
    except Exception as e:
        logger.error(f"Error in update_daily_vector_for_all_user: {e}")
        logger.error(traceback.format_exc())

def update_daily_news_for_all_user():
    try:
        user_ids = get_all_user_id()
        if not user_ids:
            return
        for user_id in user_ids:
            try:
                # Use AsyncTaskManager instead of asyncio.run()
                safe_async_run(store_daily_news(user_id, limit=10))
            except Exception as e:
                logger.error(f"Error updating daily news for user {user_id}: {e}")
                logger.error(traceback.format_exc())
    except Exception as e:
        logger.error(f"Error in update_daily_news_for_all_user: {e}")
        logger.error(traceback.format_exc())

def safe_get_all_link():
    """Safely run get_all_link using AsyncTaskManager"""
    try:
        safe_async_run(get_all_link())
    except Exception as e:
        logger.error(f"Error in RSS refresh: {e}")
        logger.error(traceback.format_exc())

def run_scheduler():
    """Run scheduler with error handling and restart capability"""
    logger.info("Starting scheduler")
    
    # Schedule tasks using AsyncTaskManager instead of asyncio.run()
    schedule.every(1).minute.do(clear_cache)
    schedule.every(6).hours.do(safe_get_all_link)
    schedule.every().day.do(delete_empty_or_expired_podcasts)
    schedule.every().day.at("08:00").do(update_daily_vector_for_all_user)
    schedule.every(1).minute.do(flush_milvus)
    schedule.every().day.at("10:00").do(update_daily_news_for_all_user)
    # Refresh database connections every hour to prevent staleness
    schedule.every(1).hour.do(refresh_db_connections)
    
    consecutive_errors = 0
    max_consecutive_errors = 10
    
    while True:
        try:
            schedule.run_pending()
            consecutive_errors = 0  # Reset error counter on success
            time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Scheduler stopped by user")
            break
        except Exception as e:
            consecutive_errors += 1
            logger.error(f"Error in scheduler loop (error #{consecutive_errors}): {e}")
            logger.error(traceback.format_exc())
            
            if consecutive_errors >= max_consecutive_errors:
                logger.critical(f"Scheduler has failed {max_consecutive_errors} times consecutively. Restarting scheduler thread...")
                # Reset error counter and continue
                consecutive_errors = 0
                time.sleep(60)  # Wait a minute before continuing
            else:
                time.sleep(5)  # Wait 5 seconds before retrying

if __name__ == "__main__":
    # When run directly, use asyncio.run() since there's no existing loop
    asyncio.run(run_scheduler())
