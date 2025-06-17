import asyncio
import schedule
from db.files import delete_file
from db.db import delete_empty_or_expired_podcasts, update_prevday_embedding, flush_milvus, get_all_user_id
from crawler.rss import get_all_link
from daily import store_daily_news
from db.cache import store
import requests
import time
from cuda_stuff import clear_cache

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
    user_ids = get_all_user_id()
    for user_id in user_ids:
        update_prevday_embedding(user_id)

def update_daily_news_for_all_user():
    user_ids = get_all_user_id()
    for user_id in user_ids:
        asyncio.run(store_daily_news(user_id, limit=10))

def run_scheduler():
    schedule.every(1).minute.do(clear_cache)
    schedule.every(6).hours.do(lambda: asyncio.run(get_all_link()))
    schedule.every().day.do(delete_empty_or_expired_podcasts)
    schedule.every().day.at("08:00").do(update_daily_vector_for_all_user)
    schedule.every(1).minute.do(flush_milvus)
    schedule.every().day.at("10:00").do(update_daily_news_for_all_user)
    while True:
        schedule.run_pending()
        time.sleep(1)

if __name__ == "__main__":
    asyncio.run(run_scheduler())
