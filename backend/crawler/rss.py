import os
import sys
import threading
import time
import feedparser
import gc
import socket
import asyncio
from tinydb import TinyDB, Query
from nanoid import generate
from langdetect import detect

current_file_dir = os.path.join(os.path.expanduser("~"), "BriefCast_data")
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db.db import create_podcast
from cuda_stuff import embedding_model
from db.cache import store


db = TinyDB(os.path.join(current_file_dir, "dbs", "rss.json"))
links = db.table('links')

def get_rss_links():
    return links.all()

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
    

async def process_feed(row):
    """
    Process a single RSS feed and return its entries.
    """
    try:        
        socket.setdefaulttimeout(10)
        feed = feedparser.parse(row['link'], etag=row['lastEtag'], modified=row['lastModified'])
        
        lastEtag = getattr(feed, 'etag', None)
        lastModified = getattr(feed, 'updated', None)
        updatedParsed = time.mktime(feed.updated_parsed) if hasattr(feed, 'updated_parsed') else None

        datas = []  
        for entry in feed.entries:
            try:
                title = entry.title
            except:
                title = None
            try:
                link = entry.link
            except:
                link = None
            try:
                item_id = entry.id
            except:
                item_id = None
            try:
                published_at = time.mktime(entry.published_parsed)
            except:
                published_at = time.time()
            try:
                published = entry.published
            except:
                published = None
            try:
                image_url = entry.media_thumbnail[0]['url']
            except:
                image_url = ""
            
            if not title or not link:
                continue
            if len(title.split()) <= 4:
                continue
            lang = detect(title)
            if not lang.startswith("en"):
                continue
            if not detect_news_url(link):
                continue
            if published_at < time.time() - 48 * 60 * 60:
                continue
            datas.append({
                "id": generate(),
                "title": title,
                "link": link,
                "image_url": image_url,
                "published_at": published_at
            })

        links.update({
            "lastEtag": lastEtag,
            "lastModified": lastModified,
            "updatedParsed": updatedParsed,
            "lastCheck": time.time(),
            "available": True,
        }, doc_ids=[row.doc_id])
        return datas
    except Exception as e:
        print(f"Error processing feed {row['link']}: {str(e)}")
        links.update({
            "lastCheck": time.time(),
            "available": False,
        }, doc_ids=[row.doc_id])
    return None

async def get_all_link(timeout=5, feed_batch_size=10):
    if store.sismember("rss_links", "rss_links"):
        return
    
    store.sadd("rss_links", "rss_links")
    
    socket.setdefaulttimeout(timeout)
    
    feeds = get_rss_links()
    total_feeds = len(feeds)
    processed_feeds = 0
    with embedding_model():
        for i in range(0, total_feeds, feed_batch_size):
            batch = feeds[i:i + feed_batch_size]
            print(f"Processing feed batch {i//feed_batch_size + 1}")
            batch_tasks = []
            for feed in batch:
                try:
                    batch_tasks.append(process_feed(feed))
                    gc.collect()
                except Exception as e:
                    print(f"Error processing feed {feed['link']}: {str(e)}")
            datas = await asyncio.gather(*batch_tasks)
            all_datas = []
            for data in datas:
                if data:
                    all_datas.extend(data)
            for data in all_datas:
                create_podcast(data['title'], data['link'], data['published_at'], data)
            processed_feeds += len(batch)
            print(f"Processed {processed_feeds}/{total_feeds} feeds")
            gc.collect()
    store.srem("rss_links", "rss_links")
    return

def get_link_status(id):
    link = links.get(doc_id=id)
    if link: 
        return {
            "id": link.doc_id,
            "link": link['link'],
            "country": link['country'],
            "category": link['category'],
            "lastCheck": link['lastCheck'],
            "available": link['available']
        }
    return None

def show_rss_links():
    links = get_rss_links()
    res = []
    for link in links:
        res.append({
            "id": link.doc_id,
            "link": link['link'],
            "country": link['country'],
            "category": link['category'],
            "lastCheck": link['lastCheck'],
            "available": link['available']
        })
    return res

def add_rss_link(link, country="GLOBAL", category="GENERAL"):
    try:
        doc = links.get(Query().link == link)
        if doc:
            return doc.doc_id
        doc_id = links.insert({
            'country': country,
            'category': category,
            'link': link,
            "lastEtag": None,
            "lastModified": None,
            "updatedParsed": None,
            "lastCheck": None,
            "available": True,
        })
        return doc_id
    except Exception as e:
        print(f"Error adding RSS link {link}: {str(e)}")
        return None

def delete_rss_link(rid):
    try:
        links.remove(doc_ids=[rid])
        return True
    except Exception as e:
        print(f"Error deleting RSS link {rid}: {str(e)}")
        return False

def update_rss_link(rid, link, country, category):
    try:
        links.update({
            'link': link,
            'country': country,
            'category': category,
        }, doc_ids=[rid])
        return True
    except Exception as e:
        print(f"Error updating RSS link {rid}: {str(e)}")
        return False
    
def check_available_rss_link(rid):
    try:
        row = links.get(doc_id=rid)
        if not row:
            return False
        def check_available():
            return asyncio.run(process_feed(row))
        threading.Thread(target=check_available).start()
        return True
    except Exception as e:
        print(f"Error checking available RSS link {rid}: {str(e)}")
        return False



if __name__ == "__main__":
    asyncio.run(get_all_link())