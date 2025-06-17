

from tinydb import TinyDB, Query
from pymilvus import MilvusClient, AnnSearchRequest, RRFRanker
from datetime import datetime
import sqlite3
import time
from urllib.parse import urlparse
import tldextract
import uuid
from nanoid import generate
import os
from io import BytesIO
import numpy as np
import sys
import threading
import os

current_file_dir = os.path.join(os.getcwd(), "db")
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db.init
from db.files import store_content, store_image, store_audio, store_transcript, get_file, delete_file, store_script
from constant.history_weight import get_embeding_mean, compute_daily_embedding, compute_batch_embedding
from db.cache import HybridLock
from cuda_stuff import embed_text

DIMENSION = int(os.getenv('VECTOR_DIM', 1024))
PODCAST_EXPIRE = int(os.getenv('PODCAST_EXPIRE', 30))

_sql_lock = HybridLock()
_milvus_lock = HybridLock()
_user_lock = HybridLock()

sqlite_client = None
milvus_client = None
user_db = None
# USER_ID = None

def flush_milvus():
    with _milvus_lock:
        milvus_client.flush(collection_name="briefcast")

def init_connections():
    with _sql_lock:
        global sqlite_client
        if sqlite_client is None:
            sql_file_path = os.path.join(current_file_dir, "dbs", "sql.db")
            sqlite_client = sqlite3.connect(sql_file_path, check_same_thread=False)
    with _milvus_lock:
        global milvus_client
        if milvus_client is None:
            milvus_file_path = os.path.join(current_file_dir, "dbs", "milvus.db")
            milvus_client = MilvusClient(milvus_file_path)
    with _user_lock:
        global user_db
        if user_db is None:
            user_file_path = os.path.join(current_file_dir, "dbs", "user.json")
            user_db = TinyDB(user_file_path)
        # global USER_ID
        # if user_db.all():
        #     USER_ID = user_db.all()[0]["id"]
        # else:
        #     USER_ID = None

init_connections()

def get_timestamp_from_date(date):
    try:
        dt = datetime.strptime(date, "%Y-%m-%d %H:%M:%S.%f")
    except ValueError:
        dt = datetime.strptime(date, "%Y-%m-%d %H:%M:%S")
    return dt.timestamp()

def create_user(user_id, password, preference, preference_vector):
    try:
        if isinstance(preference_vector, np.ndarray):
            preference_vector = preference_vector.tolist()
        with _user_lock:
            user_db.insert({
                "id": user_id,
                "password": password,
                "preference": preference,
                "last_daily_update": None,
                "last_daily_vector_update": None,
                "daily_listen_count": 0,
                "batch_count": 0,
                "daily_total_weight": 0.0,
                "batch_total_weight": 0.0,
                "prev_day_vector": preference_vector,
                "realtime_vector": preference_vector,
                "batched_vector": np.zeros(DIMENSION).tolist(),
                "daily_vector": np.zeros(DIMENSION).tolist()
            })
    except Exception as e:
        print(e)
        return None
    
def get_all_user_id():
    try:
        with _user_lock:
            return [user["id"] for user in user_db.all()]
    except Exception as e:
        print(e)
        return None
    
def get_user(user_id):
    try:
        with _user_lock:    
            user = user_db.get(Query().id == user_id)
            return user
    except Exception as e:
        print(e)
        return None
    
def update_user_location(user_id, location):
    try:
        with _user_lock:
            user_db.update({"location": location}, Query().id == user_id)
    except Exception as e:
        print(e)
        return None

def add_token(user_id, token, token_type):
    try:
        with _user_lock:
            user_tokens = user_db.get(Query().id == user_id).get("tokens", [])
            user_tokens.append({
                "token": token,
                "token_type": token_type,
                "created_at": time.time()
            })
            user_db.update({"tokens": user_tokens}, Query().id == user_id)
    except Exception as e:
        print(e)
        return None
    
def revoke_token(user_id, token):
    try:
        with _user_lock:
            user_tokens = user_db.get(Query().id == user_id).get("tokens", [])
            user_tokens = [t for t in user_tokens if t["token"] != token]
            user_db.update({"tokens": user_tokens}, Query().id == user_id)
    except Exception as e:
        print(e)
        return None
    
def get_user_tokens(user_id):
    try:
        with _user_lock:
            return user_db.get(Query().id == user_id).get("tokens", [])
    except Exception as e:
        print(e)
        return None
    
def get_user_location(user_id):
    try:
        with _user_lock:
            user = user_db.get(Query().id == user_id)
            return user["location"]
    except Exception as e:
        print(e)
        return None
    
def get_user_preference_vector(user_id):
    try:
        with _user_lock:
            user = user_db.get(Query().id == user_id)
            if user is None:
                return None
            return np.array(user["realtime_vector"])
    except Exception as e:
        print(e)
        return None
def update_user_daily_update(user_id):
    try:
        with _user_lock:
            user_db.update({"last_daily_update": time.time()}, Query().id == user_id)
    except Exception as e:
        print(e)
        return None

def get_user_last_podcast_update(user_id):
    try:
        with _user_lock:
            user = user_db.get(Query().id == user_id)
            return user["last_daily_vector_update"]
    except Exception as e:
        print(e)
        return None

def get_user_last_daily_update(user_id):
    try:
        with _user_lock:
            user = user_db.get(Query().id == user_id)
            return user["last_daily_update"]
    except Exception as e:
        print(e)
        return None

def update_user_daily_embedding(user_id, embedding, weight):
    try:
        with _user_lock:
            user = user_db.get(Query().id == user_id)
            daily_vector = user["daily_vector"]
            last_update_time = user["last_daily_vector_update"]
            total_weight = embedding * weight
            if daily_vector is not None:
                total_weight += np.array(daily_vector)
            if isinstance(total_weight, np.ndarray):
                total_weight = total_weight.tolist()
            user_db.update({"daily_vector": total_weight, "daily_total_weight": user["daily_total_weight"] + weight, "daily_listen_count": user["daily_listen_count"] + 1}, Query().id == user_id)
            return last_update_time
    except Exception as e:
        print(e)
        return None
    
def update_user_batch_embedding(user_id, embedding, weight):
    try:
        with _user_lock:
            user = user_db.get(Query().id == user_id)
            batched_vector = user["batched_vector"]
            batch_count = user["batch_count"]
            total_weight = embedding * weight
            if batched_vector is not None:  
                total_weight += np.array(batched_vector)
            if isinstance(total_weight, np.ndarray):
                total_weight = total_weight.tolist()
            user_db.update({"batched_vector": total_weight, "batch_total_weight": user["batch_total_weight"] + weight, "batch_count": batch_count + 1}, Query().id == user_id)
            return batch_count + 1
    except Exception as e:
        print(e)
        return -1
    
def update_realtime_embedding(user_id):
    try:
        with _user_lock:
            user = user_db.get(Query().id == user_id)
            prev_vector = user["realtime_vector"]
            prev_vector = np.array(prev_vector)
            batched_vector = user["batched_vector"]
            batched_vector = np.array(batched_vector)
            batch_total_weight = user["batch_total_weight"]
            batch_count = user["batch_count"]
            realtime_vector = np.zeros(DIMENSION)
            zero_weight = np.zeros(DIMENSION)
            if batch_total_weight is not None and batched_vector is not None:
                realtime_vector = get_embeding_mean(batched_vector, batch_total_weight)
            if prev_vector is not None:
                realtime_vector = compute_batch_embedding(prev_vector, realtime_vector)
            if isinstance(realtime_vector, np.ndarray):
                realtime_vector = realtime_vector.tolist()
            if isinstance(zero_weight, np.ndarray):
                zero_weight = zero_weight.tolist()
            user_db.update({"realtime_vector": realtime_vector, "batched_vector": zero_weight, "batch_total_weight": 0.0, "batch_count": 0}, Query().id == user_id)
        return True
    except Exception as e:
        print(e)
        return False

def update_prevday_embedding(user_id):
    try:
        with _user_lock:
            user = user_db.get(Query().id == user_id)
            prev_day_vector = user["prev_day_vector"]
            prev_day_vector = np.array(prev_day_vector)
            daily_vector = user["daily_vector"]
            daily_vector = np.array(daily_vector)
            daily_total_weight = user["daily_total_weight"]
            daily_listen_count = user["daily_listen_count"]
            zero_weight = np.zeros(DIMENSION)
            daily_mean = np.zeros(DIMENSION)
            if daily_total_weight is not None and daily_vector is not None:
                daily_mean = get_embeding_mean(daily_vector, daily_total_weight)
            if prev_day_vector is not None:
                daily_mean = compute_daily_embedding(prev_day_vector, daily_mean)
            if isinstance(daily_mean, np.ndarray):
                daily_mean = daily_mean.tolist()
            if isinstance(zero_weight, np.ndarray):
                zero_weight = zero_weight.tolist()  
            user_db.update({"prev_day_vector": daily_mean, "daily_vector": zero_weight, "daily_total_weight": 0.0, "daily_listen_count": 0, "last_daily_vector_update": time.time()}, Query().id == user_id)
            return True
    except Exception as e:
        print(e)
        return False

def create_playlist(user_id, name, description=""):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT playlist_id FROM user_podcast_playlists WHERE name = ? AND user_id = ?", (name, user_id))
            playlist = cursor.fetchone()
            if playlist:
                return playlist[0]
            else:
                playlist_id = generate(size=16)
                cursor.execute("INSERT INTO user_podcast_playlists (playlist_id, name, description, user_id) VALUES (?, ?, ?, ?)", (playlist_id, name, description, user_id))
            sqlite_client.commit()
            return playlist_id
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return None

def rename_playlist(user_id, playlist_id, name, description=""):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("UPDATE user_podcast_playlists SET name = ?, description = ? WHERE playlist_id = ? AND user_id = ?", (name, description, playlist_id, user_id))
            sqlite_client.commit()
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return None

def delete_playlist(user_id, playlist_id):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("DELETE FROM user_podcast_playlists WHERE playlist_id = ? AND user_id = ?", (playlist_id, user_id))
            sqlite_client.commit()
            return True
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return False

def add_to_playlist(playlist_id, podcast_id): 
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT * FROM podcast_playlist_items WHERE playlist_id = ? AND podcast_id = ?", (playlist_id, podcast_id))
            if cursor.fetchone():
                return False
            cursor.execute("INSERT INTO podcast_playlist_items (playlist_id, podcast_id) VALUES (?, ?)", (playlist_id, podcast_id))
            sqlite_client.commit()
            return True
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return False

def delete_from_playlist(playlist_id, podcast_id): 
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("DELETE FROM podcast_playlist_items WHERE playlist_id = ? AND podcast_id = ?", (playlist_id, podcast_id))
            sqlite_client.commit()
            return True
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return False

def get_user_playlists(user_id):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT playlist_id, name, description, created_at FROM user_podcast_playlists WHERE user_id = ?", (user_id,))
            playlists = cursor.fetchall()
            res = []
            for playlist in playlists:
                res.append({
                    "playlist_id": playlist[0],
                    "name": playlist[1],
                    "description": playlist[2],
                    "created_at": playlist[3],
                })
            return res
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return None

def get_playlist_items(playlist_id):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            query = """
            SELECT podcast_id, title, cover_image_url, duration_seconds, added_at
            FROM podcast_playlist_items
            JOIN podcasts ON podcast_playlist_items.podcast_id = podcasts.id
            WHERE podcast_playlist_items.playlist_id = ?
            """
            cursor.execute(query, (playlist_id,))
            items = cursor.fetchall()
            res = []
            for item in items:
                res.append({
                    "podcast_id": item[0],
                    "title": item[1],
                    "image_url": item[2],
                    "duration_seconds": item[3],
                    "added_at": item[4],
                })
            return res
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return None

def update_user_listen_position(user_id, podcast_id, position):
    """
    Update the listen position for a user
    """
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor() 
            query = """SELECT * FROM user_podcast_history WHERE podcast_id = ? AND hidden = FALSE AND user_id = ? ORDER BY listened_at DESC LIMIT 1"""
            cursor.execute(query, (podcast_id, user_id))
            history = cursor.fetchone()
            if history:
                update_query = """
                UPDATE user_podcast_history SET stop_position_seconds = ?, listened_at = CURRENT_TIMESTAMP WHERE podcast_id = ? AND hidden = FALSE AND user_id = ?
                """
                cursor.execute(update_query, (position, podcast_id, user_id))
            else:
                insert_query = """
                INSERT INTO user_podcast_history (podcast_id, stop_position_seconds, listened_at, hidden, user_id) VALUES (?, ?, CURRENT_TIMESTAMP, FALSE, ?)
                """
                cursor.execute(insert_query, (podcast_id, position, user_id))
            sqlite_client.commit()
            return True
        except Exception as e:
            sqlite_client.rollback()
            print(f"Error updating user listen position: {e}")
            return False

def add_to_listening_history(user_id, podcast_id, user_activity, completed=False, hidden=False):
    """
    Add a podcast to user's listening history
    
    Args:
        podcast_id (str): The ID of the podcast
        duration_seconds (int): Duration listened in seconds
        completed (bool): Whether the podcast was completed
        
    Returns:
        bool: True if successful, False otherwise
    """
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()

            # Check if the podcast is already in the history
            cursor.execute("SELECT podcast_id FROM user_podcast_history WHERE podcast_id = ? AND hidden = ? AND user_id = ?", (podcast_id, hidden, user_id))
            history = cursor.fetchone()
            if history and not hidden:
                # Update the history entry
                update_query = """
                UPDATE user_podcast_history
                SET
                listened_at = CURRENT_TIMESTAMP,
                hidden = ?,
                listen_duration_seconds = listen_duration_seconds + ?, 
                stop_position_seconds = ?, 
                completed = ?, 
                play_count = play_count + 1,
                download_count = download_count + ?,
                add_to_playlist = add_to_playlist + ?,
                rate = ?
                WHERE podcast_id = ? AND hidden = FALSE AND user_id = ?
                """
                cursor.execute(update_query, (hidden, user_activity['listen_duration_seconds'], user_activity['stop_position_seconds'], completed, user_activity['download_count'], user_activity['add_to_playlist'], user_activity['rating'], podcast_id, user_id))
                sqlite_client.commit()
                return True
            if not hidden:
                hidden = False
                listen_duration_seconds = user_activity['listen_duration_seconds']
                stop_position_seconds = user_activity['stop_position_seconds']
                completed = completed
                download_count = user_activity['download_count']
                add_to_playlist = user_activity['add_to_playlist']
                rating = user_activity['rating']
            else:
                hidden = True
                listen_duration_seconds = 0
                stop_position_seconds = 0
                completed = False
                download_count = 0
                add_to_playlist = 0
                rating = 0
            # Insert new history entry
            insert_query = """
            INSERT INTO user_podcast_history (
                user_id,
                podcast_id, 
                listen_duration_seconds,
                stop_position_seconds,
                completed,
                hidden,
                play_count,
                download_count,
                add_to_playlist,
                rate
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """
            
            cursor.execute(insert_query, (
                user_id,
                podcast_id,
                listen_duration_seconds,
                stop_position_seconds,
                completed,
                hidden,
                1,
                download_count,
                add_to_playlist,
                rating
            ))
            sqlite_client.commit()
            return True
            
        except Exception as e:
            sqlite_client.rollback()
            print(f"Error adding to listening history: {e}")
            return False

def create_summary_podcast(user_id, pid, pids, title, audio_url, transcript_url, duration):
    try:
        with _sql_lock:
            embeddings = get_podcast_embeddings(pids)
            dense = np.mean(embeddings, axis=0)
            embedding = embed_text([title])
            sparse = embedding['sparse'][0]
            sparse = dict(zip(sparse.col.tolist(), sparse.data.tolist()))
            cursor = sqlite_client.cursor()
            insert_query = """
            INSERT INTO podcasts (id, daily, title, link, published_at, fetched_at, content_url, cover_image_url, audio_url, transcript_url, duration_seconds)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """
            cursor.execute(insert_query, (pid, f"SUMMARY-{user_id}", title, title, datetime.now(), datetime.now(), "", "image/summary.png", audio_url, transcript_url, duration))
            with _milvus_lock:
                milvus_client.insert(
                    collection_name="briefcast",
                    data=[
                        {
                            "id": pid,
                            "published_at": time.time(), 
                            "sparse": sparse,
                            "vector": dense,
                        }
                    ]
                )
            sqlite_client.commit()
            return pid
    except Exception as e:
        with _sql_lock:
            sqlite_client.rollback()
            print(e)
            return None


def create_podcast(title, link, published_at, podcast, daily=None):
    try:
        with _sql_lock:
            query = """SELECT id FROM podcasts WHERE link = ?"""
            cursor = sqlite_client.cursor()
            cursor.execute(query, (link,))
            pid = cursor.fetchone()
            if pid:
                return pid[0]
            pid = generate(size=16)
            published_ts = datetime.fromtimestamp(published_at)
            fetched_at = podcast.get("fetched_at", 0)
            fetched_ts = datetime.fromtimestamp(fetched_at)
            content_url = podcast.get("content_url", "")
            image_url = podcast.get("image_url", "")
            audio_url = podcast.get("audio_url", "")
            transcript_url = podcast.get("transcript_url", "")
            duration = podcast.get("duration", 0)
            if daily is None:
                embedding = embed_text([title])
                sparse = embedding['sparse'][0]
                sparse = dict(zip(sparse.col.tolist(), sparse.data.tolist()))
                vector = embedding['dense'][0]
            cursor = sqlite_client.cursor()
            insert_query = """
            INSERT INTO podcasts (id, daily, title, link, published_at, fetched_at, content_url, cover_image_url, audio_url, transcript_url, duration_seconds)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """
            cursor.execute(insert_query, (pid, daily, title, link, published_ts, fetched_ts, content_url, image_url, audio_url, transcript_url, duration))
            if daily is None:
                with _milvus_lock:
                    milvus_client.insert(
                        collection_name="briefcast",
                        data=[
                            {
                                "id": pid,
                                "published_at": published_at,
                                "sparse": sparse,
                                "vector": vector,
                            }
                        ]
                    )
                    milvus_client.flush(collection_name="briefcast")
            
            sqlite_client.commit()
        if daily is None:
            tag_hot_trending(vector)
        return pid
    except Exception as e:
        with _sql_lock:
            sqlite_client.rollback()
            print(e)
            return None
    
def get_user_podcast(user_id):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            query = """
            SELECT id, title, link, published_at, fetched_at, content_url, cover_image_url, audio_url, transcript_url, duration_seconds 
            FROM podcasts WHERE daily = ?
            ORDER BY published_at DESC
            LIMIT 1
            """
            cursor.execute(query, (user_id,))
            podcast = cursor.fetchone()
            res = {
                "id": podcast[0],
                "title": podcast[1],
                "link": podcast[2],
                "published_at": podcast[3],
                "fetched_at": podcast[4],
                "content_url": podcast[5],
                "image_url": podcast[6],
                "audio_url": podcast[7],
                "transcript_url": podcast[8],
                "duration_seconds": podcast[9],
            }
            return res
        except Exception as e:
            print(e)
            return None
        
def get_summary_podcast(user_id):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            query = """
            SELECT id, title, link, published_at, fetched_at, content_url, cover_image_url, audio_url, transcript_url, duration_seconds 
            FROM podcasts WHERE daily = ?
            ORDER BY published_at DESC
            LIMIT 1
            """
            cursor.execute(query, (f"SUMMARY-{user_id}",))
            podcast = cursor.fetchone()
            res = {
                "id": podcast[0],
                "title": podcast[1],
                "link": podcast[2],
                "published_at": podcast[3],
                "fetched_at": podcast[4],
                "content_url": podcast[5],
                "image_url": podcast[6],
                "audio_url": podcast[7],
                "transcript_url": podcast[8],
                "duration_seconds": podcast[9],
            }
            return res
        except Exception as e:
            print(e)
            return None

    
def get_podcast_by_link(link): 
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT id FROM podcasts WHERE link = ?", (link,))
            podcast = cursor.fetchone()
            return podcast[0]
        except Exception as e:
            print(e)
            return None
    
def get_podcast(pid):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT id, cluster_id, title, link, published_at, fetched_at, content_url, cover_image_url, audio_url, transcript_url, duration_seconds FROM podcasts WHERE id = ?", (pid,))
            podcast = cursor.fetchone()
            if podcast is None:
                return None
            res = {
                "id": podcast[0],
                "cluster_id": podcast[1],
                "title": podcast[2],
                "link": podcast[3],
                "published_at": podcast[4],
                "fetched_at": podcast[5],
                "content_url": podcast[6],
                "image_url": podcast[7],
                "audio_url": podcast[8],
                "transcript_url": podcast[9],
                "duration_seconds": podcast[10],
            }
            return res
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return None
    
def get_podcasts(pids):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT id, cluster_id, title, link, published_at, fetched_at, content_url, cover_image_url, audio_url, transcript_url, duration_seconds FROM podcasts WHERE id IN ({})".format(','.join(['?'] * len(pids))), pids)
            podcasts = cursor.fetchall()
            res = []
            for podcast in podcasts:
                res.append({
                    "id": podcast[0],
                    "cluster_id": podcast[1],
                    "title": podcast[2],
                    "link": podcast[3],
                    "published_at": podcast[4],
                    "fetched_at": podcast[5],
                    "content_url": podcast[6],
                    "image_url": podcast[7],
                    "audio_url": podcast[8],
                    "transcript_url": podcast[9],
                    "duration_seconds": podcast[10],
                })
            return res
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return None
    

def get_history(user_id, include_hidden=False):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            if include_hidden:
                query = """
                SELECT uph.podcast_id, uph.listened_at, uph.hidden, uph.listen_duration_seconds, uph.stop_position_seconds, uph.completed, uph.play_count, uph.rate, p.title, p.cover_image_url, p.duration_seconds
                FROM user_podcast_history uph
                JOIN podcasts p ON uph.podcast_id = p.id
                WHERE uph.user_id = ?
                ORDER BY listened_at DESC;
                """
            else:
                query = """
                SELECT uph.podcast_id, uph.listened_at, uph.hidden, uph.listen_duration_seconds, uph.stop_position_seconds, uph.completed, uph.play_count, uph.rate, p.title, p.cover_image_url, p.duration_seconds
                FROM user_podcast_history uph
                JOIN podcasts p ON uph.podcast_id = p.id
                WHERE uph.hidden = false AND uph.user_id = ?
                ORDER BY listened_at DESC;
                """
            cursor.execute(query, (user_id,))
            podcasts = cursor.fetchall()
            res = []
            for podcast in podcasts:
                res.append({
                    "id": podcast[0],
                    "listened_at": podcast[1],
                    "hidden": podcast[2],
                    "listen_duration_seconds": podcast[3],
                    "stop_position_seconds": podcast[4],
                    "completed": podcast[5],
                    "play_count": podcast[6],
                    "rate": podcast[7],
                    "title": podcast[8],
                    "image_url": podcast[9],
                    "duration_seconds": podcast[10],
                })
            return res
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return None
        
def get_user_podcast_rate(user_id, podcast_id):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT rate FROM user_podcast_history WHERE user_id = ? AND podcast_id = ?", (user_id, podcast_id))
            rate = cursor.fetchone()
            if rate:
                return rate[0]
            else:
                return 0
        except Exception as e:
            sqlite_client.rollback()
            print(e)
            return None
            
        
def get_complete_user_history(user_id, podcast_ids=[], include_hidden=False):
    """
    Get complete user history
    """
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            if len(podcast_ids) > 0:
                if include_hidden:
                    placeholders = ", ".join(["?"] * len(podcast_ids))
                    query = """
                    SELECT * FROM user_podcast_history WHERE podcast_id IN ({}) AND user_id = ?
                    """.format(placeholders)
                    cursor.execute(query, podcast_ids + [user_id])
                else:
                    placeholders = ", ".join(["?"] * len(podcast_ids))
                    query = """
                    SELECT * FROM user_podcast_history WHERE podcast_id IN ({}) AND hidden = FALSE AND user_id = ?
                    """.format(placeholders)
                    cursor.execute(query, podcast_ids + [user_id])
            else:
                if include_hidden:
                    query = """
                    SELECT * FROM user_podcast_history WHERE user_id = ?
                    """
                    cursor.execute(query, [user_id])
                else:
                    query = """
                    SELECT * FROM user_podcast_history WHERE hidden = FALSE AND user_id = ?
                    """
                    cursor.execute(query, [user_id])
            history = cursor.fetchall()
            complete_history = []
            for item in history:
                complete_history.append({
                    "podcast_id": item[0],
                    "listened_at": item[1],
                    "hidden": item[2],
                    "listen_duration_seconds": item[3],
                    "stop_position_seconds": item[4],
                    "completed": item[5],
                    "play_count": item[6],
                    "add_to_playlist": item[7],
                    "rating": item[8]
                })
            return complete_history
        except Exception as e:
            sqlite_client.rollback()
            print(f"Error getting complete user history: {e}")
            return []
    
def search_podcast_by_dense(vector, limit=10, history=[], time_range=None):
    try:
        search_params = {
            "output_fields": ["id"]
        }
        filter = []
        if history:
            filter.append(f'id not in {history}')

        if time_range:
            filter.append(f'published_at >= {time_range}')

        if filter:
            search_params["filter"] = " AND ".join(filter)

        with _milvus_lock:
            res = milvus_client.search(
                anns_field="vector",
                collection_name="briefcast",
                data=[vector],
                limit=limit,
                **search_params 
            )
            res = set([r["id"] for r in res[0]])
            return list(res)[:limit]
    except Exception as e:
        print(e)
        return None

def search_podcast_hybrid(query, limit=10, history=[], time_range=None):
    try:
        embedding = embed_text([query])
        sparse = embedding['sparse'][0]
        sparse = dict(zip(sparse.col.tolist(), sparse.data.tolist()))
        dense = embedding['dense'][0]
        dense_search_params = {"metric_type": "COSINE", "params": {}}
        dense_req = AnnSearchRequest(
            [dense], "vector", dense_search_params, limit=limit
        )
        sparse_search_params = {"metric_type": "IP", "params": {}}
        sparse_req = AnnSearchRequest(
            [sparse], "sparse", sparse_search_params, limit=limit
        )

        search_params = {
            "output_fields": ["id"]
        }
        filter = []
        if history:
            filter.append(f'id not in {history}')
        if time_range:
            filter.append(f'published_at >= {time_range}')

        if filter:
            search_params["filter"] = " AND ".join(filter)

        with _milvus_lock:
            res = milvus_client.hybrid_search(
                "briefcast",
                [sparse_req, dense_req],
                ranker=RRFRanker(),
                limit=limit*2,
                **search_params
            )
            res = set([r["id"] for r in res[0]])
            return list(res)[:limit]
    except Exception as e:
        print(e)
        return None

def get_hot_podcasts(limit=10):
    with _sql_lock:
        try:
            timestamp_cutoff = datetime.fromtimestamp(time.time() - 1000 * 60 * 60 * 36 / 1000.0)
            cursor = sqlite_client.cursor()
            query = """
            WITH ranked_podcasts AS (
                SELECT
                    p.id,
                    p.title,
                    p.cover_image_url,
                    p.duration_seconds,
                    p.published_at,
                    c.cid,
                    ROW_NUMBER() OVER (
                        PARTITION BY c.cid
                        ORDER BY c.hot_score DESC, c.hot_time DESC, p.published_at DESC
                    ) AS row_num
                FROM podcasts p
                JOIN clusters c ON p.cluster_id = c.cid
                WHERE c.hot = TRUE AND p.published_at > ? AND c.hot_score > 1
            )
            SELECT
                id,
                title,
                cover_image_url,
                duration_seconds,
                published_at,
                cid
            FROM ranked_podcasts
            WHERE row_num = 1
            LIMIT ?;
            """
            cursor.execute(query, (timestamp_cutoff, limit))
            all_podcasts = cursor.fetchall()
            pid = set()
            podcasts = []
            for podcast in all_podcasts:
                if podcast[0] not in pid:
                    ts = get_timestamp_from_date(podcast[4])
                    podcasts.append({
                        "id": podcast[0],
                        "title": podcast[1],
                        "image_url": podcast[2],
                        "duration": podcast[3],
                        "published_at": ts
                    })
                    pid.add(podcast[0])
            return podcasts
        except Exception as e:
            print(e)
            return None
    
def get_trending_podcasts(user_preference, limit=10):
    with _sql_lock:
        try:
            timestamp_cutoff = datetime.fromtimestamp(time.time() - 1000 * 60 * 60 * 36 / 1000.0)
            cursor = sqlite_client.cursor()
            query = """
            WITH ranked_trending AS (
                SELECT
                    p.id,
                    p.title,
                    p.link,
                    p.cover_image_url,
                    p.duration_seconds,
                    p.published_at,
                    c.cid,
                    ROW_NUMBER() OVER (
                        PARTITION BY c.cid
                        ORDER BY c.trending_score DESC, c.trending_time DESC, p.published_at DESC
                    ) AS row_num
                FROM podcasts p
                JOIN clusters c ON p.cluster_id = c.cid
                WHERE c.trending = TRUE AND p.published_at > ? AND c.trending_score > 1
            )
            SELECT
                id,
                title,
                link,
                cover_image_url,
                duration_seconds,
                published_at,
                cid
            FROM ranked_trending
            WHERE row_num = 1;
            """
            cursor.execute(query, (timestamp_cutoff,))
            podcasts = cursor.fetchall()
            pid = set([item[0] for item in podcasts])
            if len(pid) == 0:
                return []
            search_params = {
                "output_fields": ["id"],
                "metric_type": "COSINE",
                "params": {
                    "radius": 0.7
                },
                "filter": f"id in {list(pid)}"
            }
            with _milvus_lock:
                res = milvus_client.search(
                    anns_field="vector",
                    collection_name="briefcast",
                    data=[user_preference],
                    limit=limit*2,
                    **search_params
                )
                res = set([r["id"] for r in res[0]])
            if len(res) == 0:
                return []
            query = """
            SELECT id, title, cover_image_url, duration_seconds, published_at FROM podcasts WHERE id IN ({})
            """.format(','.join(['?'] * len(res)))
            cursor.execute(query, list(res))
            podcasts = cursor.fetchall()
            resp = []
            for podcast in podcasts:
                published_at = get_timestamp_from_date(podcast[4])
                resp.append({
                    "id": podcast[0],
                    "title": podcast[1],
                    "image_url": podcast[2],
                    "duration": podcast[3],
                    "published_at": published_at
                })
            return resp[:limit]
        except Exception as e:
            print(e)
            return None
    
def get_base_url(url):
    parsed = urlparse(url)
    ext = tldextract.extract(url)
    l1 = f"{ext.domain}.{ext.suffix}"

    return parsed.netloc, l1
    
def tag_hot_trending(podcast_embedding, threshold=0.7):
    """
    Tag a podcast as hot or trending
    """
    with _sql_lock:
        try:
            hot_links = ["reuters.com", "apnews.com", "cnn.com", "bbc.com", "nytimes.com", "wsj.com", "cnbc.com", "ft.com", "www.theguardian.com", "www.washingtonpost.com", "www.scmp.com", "english.news.cn", "www.cbc.ca", "www.forbes.com"]
            pids = set()
            timestamp_cutoff = time.time() - 1000 * 60 * 60 * 36
            search_params = {
                "output_fields": ["id"],
                "metric_type": "COSINE",
                "params": {
                    "radius": threshold,
                    "range_filter": 1.0
                },
                "filter": f"published_at >= {timestamp_cutoff}"
            }
            with _milvus_lock:
                results = milvus_client.search(
                    collection_name="briefcast",
                    data=[podcast_embedding],
                    anns_field="vector",
                    limit=100,
                    **search_params
                )
                if results and len(results) > 0:
                    for result in results[0]:
                        if result.get("distance", 0) > threshold and result["entity"].get("id"):
                            pids.add(result["entity"].get("id"))

            pids = list(pids)
            if len(pids) == 0:
                return []
            
            cursor = sqlite_client.cursor()
            query = """
            SELECT cluster_id, link
            FROM podcasts
            WHERE id IN ({}) AND cluster_id IS NOT NULL;
            """.format(','.join(['?'] * len(pids)))
            cursor.execute(query, pids)
            results = cursor.fetchall()

            links = set()

            hot = False
            trending = False
            trending_time = None
            hot_time = None
            hot_score = 0
            trending_score = 0

            for link in results:
                base_url = get_base_url(link[1])
                if base_url not in links:
                    links.add(base_url)
                    if base_url in hot_links or any(link.endswith(base_url) for link in hot_links):
                        hot_score += 1
                    trending_score += 1

            if hot_score >= 2:
                hot = True
            if trending_score >= 4:
                trending = True

            if results:
                cid = results[0][0]
                cursor.execute("UPDATE clusters SET hot = ?, trending = ?, hot_score = ?, trending_score = ?, hot_time = ?, trending_time = ? WHERE cid = ?", (hot, trending, hot_score, trending_score, hot_time, trending_time, cid))
            else:
                cid = str(uuid.uuid4())
                cursor.execute("INSERT INTO clusters (cid, hot, trending, hot_score, trending_score, hot_time, trending_time) VALUES (?, ?, ?, ?, ?, ?, ?)", (cid, hot, trending, hot_score, trending_score, hot_time, trending_time))

            for pid in pids:
                cursor.execute("UPDATE podcasts SET cluster_id = ? WHERE id = ?", (cid, pid))
            sqlite_client.commit()
            return pids
        except Exception as e:
            sqlite_client.rollback()
            print(f"Error tagging hot and trending podcasts: {e}")
            return []
    
def update_podcast_image(pid, image_url):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("UPDATE podcasts SET cover_image_url = ? WHERE id = ?", (image_url, pid))
            sqlite_client.commit()
        except Exception as e:
            sqlite_client.rollback()
            print(e)


def get_podcast_fetched_time(pid):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT fetched_at FROM podcasts WHERE id = ?", (pid,))
            fetched_at = cursor.fetchone()
            if fetched_at:
                return fetched_at[0]
            else:
                return None
        except Exception as e:
            print(e)
            return None
            

def update_podcast_fetched_at(pid):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("UPDATE podcasts SET fetched_at = CURRENT_TIMESTAMP WHERE id = ?", (pid,))
            sqlite_client.commit()  
        except Exception as e:
            sqlite_client.rollback()
            print(e)

def store_podcast_content(pid, content):
    with _sql_lock:
        try:
            path = store_content(content)
            cursor = sqlite_client.cursor()
            cursor.execute("UPDATE podcasts SET content_url = ?, fetched_at = CURRENT_TIMESTAMP WHERE id = ?", (path, pid))
            sqlite_client.commit()
        except Exception as e:
            sqlite_client.rollback()
            print(e)

def store_podcast_image(pid, image):
    with _sql_lock:
        try:
            path = store_image(image)
            cursor = sqlite_client.cursor()
            cursor.execute("UPDATE podcasts SET cover_image_url = ? WHERE id = ?", (path, pid))
            sqlite_client.commit()
        except Exception as e:
            sqlite_client.rollback()
            print(e)

def store_podcast_audio(pid, audio, duration):
    with _sql_lock:
        try:
            path = store_audio(audio)
            cursor = sqlite_client.cursor()
            cursor.execute("UPDATE podcasts SET audio_url = ?, duration_seconds = ? WHERE id = ?", (path, duration, pid))
            sqlite_client.commit()
        except Exception as e:
            sqlite_client.rollback()
            print(e)

def store_podcast_transcript(pid, transcript):
    with _sql_lock:
        try:
            path = store_transcript(transcript)
            cursor = sqlite_client.cursor()
            cursor.execute("UPDATE podcasts SET transcript_url = ? WHERE id = ?", (path, pid))
            sqlite_client.commit()
        except Exception as e:
            sqlite_client.rollback()
            print(e)

def store_podcast_script(pid, script):
    with _sql_lock:
        try:
            path = store_script(script)
            cursor = sqlite_client.cursor()
            cursor.execute("UPDATE podcasts SET script_url = ? WHERE id = ?", (path, pid))
            sqlite_client.commit()
        except Exception as e:
            sqlite_client.rollback()
            print(e)

def get_podcast_script(pid):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT script_url FROM podcasts WHERE id = ?", (pid,))
            path = cursor.fetchone()[0]
            if path:
                file = get_file(path)
                file = file.getvalue().decode("utf-8")
                return file
            else:
                return None
        except Exception as e:
            print(e)
            return None


def get_podcast_content(pid):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT content_url FROM podcasts WHERE id = ?", (pid,))
            path = cursor.fetchone()[0]
            if path:
                file = get_file(path)
                file = file.getvalue().decode("utf-8")
                return file
            else:
                return None
        except Exception as e:
            print(e)
            return None
    
def get_podcast_image(pid):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT cover_image_url FROM podcasts WHERE id = ?", (pid,))
            path = cursor.fetchone()[0]
            if path:
                return get_file(path)
            else:
                return None
        except Exception as e:
            print(e)
            return None
    
def get_podcast_audio(pid):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT audio_url FROM podcasts WHERE id = ?", (pid,))
            path = cursor.fetchone()[0]
            if path:
                return get_file(path)
            else:
                return None
        except Exception as e:
            print(e)
            return None
    
def get_podcast_transcript(pid):
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            cursor.execute("SELECT transcript_url FROM podcasts WHERE id = ?", (pid,))
            path = cursor.fetchone()[0]
            if path:
                file = get_file(path)
                file = file.getvalue().decode("utf-8")
                return file.splitlines()
            else:
                return None
        except Exception as e:
            print(e)
            return None

def delete_empty_or_expired_podcasts():
    with _sql_lock:
        try:
            cursor = sqlite_client.cursor()
            expired_time = datetime.fromtimestamp(time.time() - 1000 * 60 * 60 * 24 * PODCAST_EXPIRE)

            query = """
            SELECT id, content_url, cover_image_url, audio_url, transcript_url, script_url
            FROM podcasts
            WHERE published_at < ?
            AND published_at < datetime('now', '-{} days')
            AND fetched_at > datetime(0, 'unixepoch')
            AND content_url IS NOT NULL
            AND content_url != ''
            """.format(PODCAST_EXPIRE)
            cursor.execute(query, (expired_time,))
            podcasts = cursor.fetchall()
            pids = [podcast[0] for podcast in podcasts]
            with _milvus_lock:
                milvus_client.delete(
                    collection_name="briefcast",
                    ids=pids
                )
            for podcast in podcasts:
                delete_file(podcast[1])
                delete_file(podcast[2])
                delete_file(podcast[3])
                delete_file(podcast[4])
                delete_file(podcast[5])
            cursor.execute("DELETE FROM podcasts WHERE id IN ({})".format(", ".join(pids)))
            sqlite_client.commit()
            print(f"Deleted {len(podcasts)} podcasts")
        except Exception as e:
            sqlite_client.rollback()
            print(e)

def get_podcast_embeddings(pids):
    try:
        with _milvus_lock:
            res = milvus_client.query(
                collection_name="briefcast",
                filter=f"id in {pids}",
                output_fields=["vector"]
            )
            if res:
                return [item["vector"] for item in res]
            else:
                return None
    except Exception as e:
        print(e)
        return None
    
def get_podcast_embedding(pid):
    try:
        with _milvus_lock:
            res = milvus_client.query(
                collection_name="briefcast",
                filter=f"id == '{pid}'",
                output_fields=["vector"]
            )
            if res:
                return res[0]["vector"]
            else:
                return None
    except Exception as e:
        print(e)
        return None