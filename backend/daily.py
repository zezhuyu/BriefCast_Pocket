from db.db import get_user_last_daily_update, update_user_daily_update, get_user, search_podcast_by_dense, get_podcasts, get_user_podcast, get_history, create_podcast, add_to_listening_history, get_user_location
from datetime import datetime, timedelta
from db.files import store_audio, store_transcript
from podcast import generate_daily_news, apply_times, combine_audio, combine_lyrics
from cuda_stuff import get_audio_duration
from crawler.news_crawler import news_crawler
import time
import asyncio
import threading
from db.cache import store


async def store_daily_news(user_id, location=None, limit=5, force=False, summary=False):
    if store.sismember("daily_news", user_id):
        print("Daily news already exists")
        return None, None, None
    store.sadd("daily_news", user_id)
    try:
        user = get_user(user_id)
        if user is None:
            return None
        history = get_history(user_id, include_hidden=True)
        history_ids = [h['id'] for h in history]
        prev_day_vector = user.get("prev_day_vector")
        if prev_day_vector is None:
            return None
        pids = search_podcast_by_dense(prev_day_vector, limit=limit*10, history=history_ids, time_range=time.time() - 60 * 60 * 30)
        if len(pids) == 0:
            return None
        podcasts = get_podcasts(pids)
        pids = await news_crawler(podcasts, find=limit)
        if location is None or location == [0, 0]:
            location = get_user_location(user_id)
        audio, lyrics, times = await generate_daily_news(pids, location=location, summary=summary)
        combined_lyrics = apply_times(lyrics, times)
        combined_audio = combine_audio(audio)
        combined_audio.seek(0)
        duration = get_audio_duration(combined_audio)
        audio_url = store_audio(combined_audio)
        transcript_url = store_transcript(combined_lyrics)
        published_at = time.time()
        title = "Briefcast Daily News " + datetime.now().strftime("%m-%d")
        link = "briefcast " + datetime.now().strftime("%m-%d-%Y-%H-%M-%S")
        data = {
            "title": title,
            "link": link,
            "published_at": published_at,
            "duration": duration,
            "transcript_url": transcript_url,
            "audio_url": audio_url,
            "image_url": "image/daily.png",
            "content_url": ", ".join(pids)
        }
        id = create_podcast(title, link, published_at, data, daily=user_id)
        for pid in pids:
            add_to_listening_history(user_id, pid, {}, hidden=True)
        if not force:
            update_user_daily_update(user_id)
        store.srem("daily_news", user_id)
        return id
    except Exception as e:
        print(e)
        store.srem("daily_news", "user_id")
        return None
    
    


def generate_daily_podcast(user_id, force=False, location=None, limit=5, summary=False):
    current_time = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    last_daily_update = get_user_last_daily_update(user_id)
    podcast = get_user_podcast(user_id)
    if podcast is not None:
        try:
            dt = datetime.strptime(podcast['published_at'], "%Y-%m-%d %H:%M:%S.%f")
        except ValueError:
            dt = datetime.strptime(podcast['published_at'], "%Y-%m-%d %H:%M:%S")
        last_daily_update = dt.timestamp()
        if last_daily_update and last_daily_update > current_time and not force and podcast:
            return podcast
        if force and last_daily_update > time.time() - 60 * 10:
            return podcast
    def load_content_task():
        asyncio.run(store_daily_news(user_id, location, limit=limit, force=force, summary=summary))
    threading.Thread(target=load_content_task).start()
    data = {
            "id": "",
            "title": "Briefcast Daily News " + datetime.now().strftime("%m-%d"),
            "link": "briefcast",
            "published_at": datetime.now(),
            "fetched_at": datetime.now(),
            "content_url": "",
            "image_url": "image/daily.png",
            "audio_url": "",
            "transcript_url": "",
            "duration_seconds": 0,
        }
    return data
