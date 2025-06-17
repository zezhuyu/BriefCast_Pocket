import asyncio
import threading
import sys
import os
import secrets
import string

if __name__ == "__main__":
    import multiprocessing
    multiprocessing.set_start_method("fork")

from datetime import datetime, timedelta
import os, numpy as np
from dotenv import dotenv_values, set_key, load_dotenv
from event_runner import run_scheduler
from flask import Flask, request, jsonify, send_file, make_response
from flask_cors import CORS
from strawberry.flask.views import GraphQLView
import time
import json
import hashlib
import jwt
from functools import wraps
import bcrypt

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from podcast import store_transition_audio, create_news_summary_podcast, generate_id, create_news_summary_podcast, create_podcast
from db.db import get_podcast, get_podcast_embedding, get_user_preference_vector, get_hot_podcasts, get_trending_podcasts, get_podcasts, search_podcast_by_dense, search_podcast_hybrid, get_history, update_user_listen_position, init_connections, update_user_location, get_user_podcast_rate, create_user
from db.db import create_playlist, rename_playlist, delete_playlist, add_to_playlist, delete_from_playlist, get_playlist_items, get_user_playlists, get_user, get_user_tokens, add_token, revoke_token
from db.files import *
from db.cache import store
from daily import generate_daily_podcast
from user_activity import user_activity_log, search
from graphql_api import schema
from crawler.news_crawler import news_crawler
from crawler.rss import get_all_link, show_rss_links, add_rss_link, delete_rss_link, update_rss_link, get_link_status, check_available_rss_link
from cuda_stuff import embedding_model
from constant.preference import topic_embedding, sub_labels_embedding
load_dotenv()

EMBEDDING_DIM = os.getenv("EMBEDDING_DIM", 1024)

app = Flask(__name__)
CORS(app)

def generate_secure_password(length=16):
    if length < 8:
        raise ValueError("Password length should be at least 8 characters")

    letters = string.ascii_letters
    digits = string.digits
    symbols = string.punctuation

    password = [
        secrets.choice(letters),
        secrets.choice(digits),
        secrets.choice(symbols)
    ]
    all_chars = letters + digits + symbols
    password += [secrets.choice(all_chars) for _ in range(length - 3)]
    secrets.SystemRandom().shuffle(password)

    return ''.join(password)

def get_secret_key():
    secret_key = os.getenv("SECRET_KEY")
    if not secret_key:
        secret_key = generate_secure_password()
        set_key(os.path.join(os.path.dirname(__file__), '.env'), "SECRET_KEY", secret_key)
    return secret_key

SECRET_KEY = get_secret_key()

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            token = request.headers['Authorization'].replace('Bearer ', '')
        if 'token' in request.cookies:
            token = request.cookies['token']

        if not token:
            return jsonify({'error': 'Token is missing'}), 401

        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            uid = payload.get("uid") or payload.get("sub")

            if not get_user(uid):
                return jsonify({'error': 'User not found'}), 401
            tokens = get_user_tokens(uid)
            if token not in [t["token"] for t in tokens]:
                return jsonify({'error': 'Token not found'}), 401
            
            request.environ['USER_ID'] = uid

        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'Token has expired'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'error': 'Invalid token'}), 401

        return f(*args, **kwargs)
    return decorated

@app.route('/files/<file_type>/<file_name>', methods=['GET'])
def find_file(file_type, file_name):
    try:
        file = get_file(f"{file_type}/{file_name}")
        if file is None:
            return jsonify({"error": "File not found"}), 404
        name, ext = os.path.splitext(file_name)
        if file_type == "audio" or ext == ".wav" or ext == ".mp3":
            return send_file(file, mimetype='audio/mpeg')
        elif file_type == "image" or ext == ".jpg" or ext == ".jpeg" or ext == ".png":
            return send_file(file, mimetype='image/jpeg')
        elif file_type == "transcript" or ext == ".txt" or ext == ".lrc":
            return send_file(file, mimetype='text/plain')
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/signup', methods=['POST'])
def signup():
    try:
        ip = request.remote_addr
        if ip != "127.0.0.1":
            return jsonify({"error": "Invalid IP address"}), 401
        data = request.json
        user_id = data.get("user_id")
        password = data.get("password")
        preference = data.get("preference", None)
        preference_vector = np.zeros(EMBEDDING_DIM)
        for k, v in preference['subtopics'].items():
            sub_preference_vector = np.zeros(EMBEDDING_DIM)
            if len(v) == 0:
                preference_vector += topic_embedding[k]
            else:
                for sub in v:
                    sub_preference_vector += sub_labels_embedding[k][sub]
                preference_vector += sub_preference_vector / len(v)
        create_user(user_id, password, preference, preference_vector)
        payload = {
            'uid': user_id,
            'exp': datetime.now() + timedelta(days=1)
        }
        token = jwt.encode(payload, SECRET_KEY, algorithm='HS256')
        add_token(user_id, token, "web")
        resp = make_response(jsonify({"token": token}))
        resp.set_cookie('token', token, max_age=60 * 60 * 24, secure=True, httponly=True, samesite='Lax')
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/signin', methods=['POST'])
def signin():
    try:
        data = request.json
        user_id = data.get("user_id")
        password = data.get("password")
        user = get_user(user_id)
        if user is None:
            return jsonify({"error": "User not found"}), 404
        if not bcrypt.checkpw(user["password"].encode('utf-8'), password.encode('utf-8')):
            return jsonify({"error": "Invalid password"}), 401
        payload = {
            'uid': user_id,
            'exp': datetime.now() + timedelta(days=1)
        }
        token = jwt.encode(payload, SECRET_KEY, algorithm='HS256')
        add_token(user_id, token, "web")
        resp = make_response(jsonify({"token": token}))
        resp.set_cookie('token', token, max_age=60 * 60 * 24, secure=True, httponly=True, samesite='Lax')
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/config', methods=['GET'])
@token_required
def get_config():
    try:
        ip = request.remote_addr
        if ip != "127.0.0.1":
            return jsonify({"error": "Invalid IP address"}), 401
        return jsonify(dotenv_values())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/config', methods=['POST'])
@token_required
def set_config():
    try:
        ip = request.remote_addr
        if ip != "127.0.0.1":
            return jsonify({"error": "Invalid IP address"}), 401
        data = request.json
        for key, value in data.items():
            set_key(os.path.join(os.path.dirname(__file__), '.env'), key, value)
        return jsonify({"message": "Config updated successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/rss/refresh', methods=['GET'])
@token_required
def update_user():
    try:
        def update_rss_links():
            asyncio.run(get_all_link())
        threading.Thread(target=update_rss_links).start()
        return jsonify({"message": "RSS links updated successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/rss', methods=['GET'])
@token_required
def get_rss():
    try:
        return jsonify(show_rss_links())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/rss', methods=['POST'])
@token_required
def add_rss():
    try:
        data = request.json
        link = data.get("link")
        country = data.get("country", "GLOBAL")
        category = data.get("category", "GENERAL")
        add_rss_link(link, country, category)
        return jsonify({"message": "RSS added successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/rss/<rid>', methods=['DELETE'])
@token_required
def delete_rss(rid):
    try:
        rid = int(rid)
        delete_rss_link(rid)
        return jsonify({"message": "RSS deleted successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/rss/<rid>', methods=['PUT'])
@token_required
def update_rss(rid):
    try:
        rid = int(rid)
        data = request.json
        link = data.get("link")
        country = data.get("country", "GLOBAL")
        category = data.get("category", "GENERAL")
        update_rss_link(rid, link, country, category)
        return jsonify({"message": "RSS updated successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/rss/<rid>', methods=['GET'])
@token_required
def get_rss_link(rid):
    try:
        rid = int(rid)
        return jsonify(get_link_status(rid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/rss/<rid>/check', methods=['GET'])
@token_required
def check_rss_link(rid):
    try:
        rid = int(rid)
        check_available_rss_link(rid)
        return jsonify({"message": "RSS link checked successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/user', methods=['GET'])
@token_required
def find_user():
    try:
        user_id = request.environ.get("USER_ID")
        user = get_user(user_id)
        if user is None:
            return jsonify({"error": "User not found"}), 404
        user = {
            "id": user["id"],
            "preference": user["preference"],
            "location": user["location"] if "location" in user else [0, 0],
            "tokens": user["tokens"] if "tokens" in user else [],
        }
        return jsonify(user)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/refresh', methods=['GET'])
@token_required
def refresh():
    try:
        user_id = request.environ.get("USER_ID")
        token = request.cookies.get('token')
        if not token:
            return jsonify({"error": "Token not found"}), 401
        payload = {
            'uid': user_id,
            'exp': datetime.now() + timedelta(days=1)
        }
        token = jwt.encode(payload, SECRET_KEY, algorithm='HS256')
        add_token(user_id, token, "web")
        revoke_token(user_id, token)
        resp = make_response(jsonify({"token": "success"}))
        resp.set_cookie('token', token, max_age=60 * 60 * 24, secure=True, httponly=True, samesite='Lax')
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/signout', methods=['GET'])
@token_required
def signout():
    try:
        user_id = request.environ.get("USER_ID")
        token = request.cookies.get('token')
        revoke_token(user_id, token)
        resp = make_response(jsonify({"message": "success"}))
        resp.delete_cookie('token')
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/token', methods=['POST'])
@token_required
def get_token():
    try:
        ip = request.remote_addr
        if ip != "127.0.0.1":
            return jsonify({"error": "Invalid IP address"}), 401
        data = request.json
        user_id = request.environ.get("USER_ID")
        payload = {
            'uid': user_id
        }
        token = jwt.encode(payload, SECRET_KEY, algorithm='HS256')
        add_token(user_id, token, "mobile")
        return jsonify({"token": token})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/token', methods=['DELETE'])
@token_required
def delete_token():
    try:
        data = request.json
        user_id = request.environ.get("USER_ID")
        token = data.get("token")
        revoke_token(user_id, token)
        return jsonify({"message": "Token deleted successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/token', methods=['GET'])
@token_required
def get_tokens():
    try:
        user_id = request.environ.get("USER_ID")
        tokens = get_user_tokens(user_id)
        tokens = [token for token in tokens if token["token_type"] == "mobile"]
        return jsonify(tokens)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/podcast/<podcast_id>', methods=['GET'])
@token_required
def find_podcast(podcast_id):
    try:
        user_id = request.environ.get("USER_ID")
        podcast = get_podcast(podcast_id)
        if podcast is None:
            return jsonify({"error": "Podcast not found"}), 404
        def load_content_task():
            asyncio.run(create_podcast(podcast["id"]))
        threading.Thread(target=load_content_task).start()
        rate = get_user_podcast_rate(user_id, podcast_id)
        if podcast["image_url"] == "":
            podcast["image_url"] = "image/default.png"
        podcast["rate"] = rate
        return jsonify(podcast)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/generate', methods=['POST'])
@token_required
def generate():
    try:
        user_id = request.environ.get("USER_ID")
        data = request.json
        location = request.json.get("location", None)
        if location is not None and location != [0, 0]:
            update_user_location(user_id, location)
        force = request.json.get("force", False)
        summary = request.json.get("summary", False)
        podcast = generate_daily_podcast(user_id, force=force, location=location, summary=summary)
        return jsonify(podcast)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/transition', methods=['POST'])
@token_required
def transition():
    try:
        data = request.json
        id1 = data.get("id1")
        id2 = data.get("id2")
        if not id1 or not id2:
            return jsonify({"error": "No id1 or id2 provided"}), 400
        if id1 == id2:
            return jsonify({"error": "id1 and id2 are the same"}), 400
        if store.exists(f"{id1}:{id2}"):
            transition_files = store.get(f"{id1}:{id2}")
            if isinstance(transition_files, dict):
                transition_files["image_url"] = "image/host.png"
                return jsonify(transition_files)
            else:
                return jsonify({"error": "Transition files not found"}), 404
        def load_transition_task():
            asyncio.run(store_transition_audio(id1, id2))
        threading.Thread(target=load_transition_task).start()
        transition = {
                "image_url": "image/host.png",
                "audio_url": "",
                "transcript_url": "",
                "secs": 0
            }
        return jsonify(transition)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/summary', methods=['POST'])
@token_required
def get_summary():
    try:
        user_id = request.environ.get("USER_ID")
        data = request.json
        pids = data.get("pids")
        if not pids:
            return jsonify({"error": "No pids provided"}), 400
        pid = generate_id(pids)
        podcast = get_podcast(pid)
        if podcast:
            podcast["image_url"] = "image/summary.png"
            return jsonify(podcast)
        def load_summary_task():
            asyncio.run(create_news_summary_podcast(user_id, pids))
        threading.Thread(target=load_summary_task).start()
        summary = {
            "id": pid,
            "cluster_id": "",
            "image_url": "image/summary.png",
            "title": "Summary",
            "link": "summary",
            "published_at": datetime.now(),
            "fetched_at": datetime.now(),
            "content_url": "",
            "audio_url": "",
            "transcript_url": "",
            "duration_seconds": 0
        }
        return jsonify(summary)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/history', methods=['GET'])
@token_required
def find_history():
    try:
        user_id = request.environ.get("USER_ID")
        history = get_history(user_id)
        podcasts = []
        for item in history:
            if not item["hidden"]:
                if item["image_url"] == "":
                    item["image_url"] = "image/default.png"
                podcasts.append(item)
        return jsonify(podcasts)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/search', methods=['GET'])
@token_required
def user_search():
    try:
        user_id = request.environ.get("USER_ID")
        query = request.args.get('q', '')
        podcasts = []
        with embedding_model():
            pids = search_podcast_hybrid(query, limit=20)
            search(user_id, query)
            podcasts = get_podcasts(pids)
            for podcast in podcasts:
                if podcast["image_url"] == "":
                    podcast["image_url"] = "image/default.png"
        return jsonify(podcasts)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/recommendations', methods=['GET'])
@app.route('/recommendations/<podcast_id>', methods=['GET'])
@token_required
def get_recommendations(podcast_id=None):
    try:
        user_id = request.environ.get("USER_ID")
        if podcast_id:
            embedding = get_podcast_embedding(podcast_id)
            if embedding:
                preference_vector = embedding
            else:
                preference_vector = get_user_preference_vector(user_id)
        else:
            preference_vector = get_user_preference_vector(user_id)
        if preference_vector is None:
            return jsonify({"error": "User not found"}), 404
        history = get_history(user_id, include_hidden=True)
        history = [item["id"] for item in history]
        pids = search_podcast_by_dense(preference_vector, limit=100, history=history, time_range=time.time() - 60 * 60 * 24 * 7)
        podcasts = get_podcasts(pids)
        pids = asyncio.run(news_crawler(podcasts, find=20))
        podcasts = [podcast for podcast in podcasts if podcast["id"] in pids]
        for podcast in podcasts:
            if podcast["image_url"] == "":
                podcast["image_url"] = "image/default.png"
        return jsonify(podcasts)
    except Exception as e:
        print(e, flush=True)
        return jsonify({"error": str(e)}), 500
    
@app.route('/trending', methods=['GET'])
@token_required
def get_hot_trending():
    try:
        non_duplicate_podcasts = []
        pids = set()
        user_id = request.environ.get("USER_ID")
        preference = get_user_preference_vector(user_id)
        all = get_hot_podcasts(limit=5)
        all.extend(get_trending_podcasts(preference, limit=5))
        for podcast in all:
            if podcast["id"] not in pids:
                if podcast["image_url"] == "":
                    podcast["image_url"] = "image/default.png"
                non_duplicate_podcasts.append(podcast)
                pids.add(podcast["id"])
        return jsonify(non_duplicate_podcasts)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/playlists', methods=['GET'])
@token_required
def get_playlists():
    try:
        user_id = request.environ.get("USER_ID")
        playlists = get_user_playlists(user_id)
        res = []
        for item in playlists:
            item["id"] = item["playlist_id"]
            res.append(item)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/playlist', methods=['POST'])
@token_required
def new_playlist():
    try:
        name = request.json.get("name")
        description = request.json.get("description", "")
        user_id = request.environ.get("USER_ID")
        playlist_id = create_playlist(user_id, name, description)
        return jsonify({"message": "Playlist created successfully", "id": playlist_id}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/playlist', methods=['PUT'])
@token_required
def update_playlist():
    try:
        user_id = request.environ.get("USER_ID")
        data = request.json
        name = data.get("name")
        description = data.get("description", "")
        playlist_id = data.get("id")
        rename_playlist(user_id, playlist_id, name, description)
        return jsonify({"message": "Playlist updated successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/playlist', methods=['DELETE'])
@token_required
def remove_playlist():
    try:
        user_id = request.environ.get("USER_ID")
        playlist_id = request.json.get("id")
        delete_playlist(user_id, playlist_id)
        return jsonify({"message": "Playlist deleted successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/playlist/<playlist_id>', methods=['GET'])
@token_required
def get_playlist(playlist_id):
    try:
        playlist = get_playlist_items(playlist_id)
        res = []
        for item in playlist:
            if item["image_url"] == "":
                item["image_url"] = "image/default.png"
            item["id"] = item["podcast_id"]
            res.append(item)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/playlist/<playlist_id>', methods=['POST'])
@token_required
def add_playlist(playlist_id):
    try:
        data = request.json
        podcast_id = data.get("podcast_id")
        if not podcast_id:
            return jsonify({"message": "no podcast id provided"}), 400
        add_to_playlist(playlist_id, podcast_id)
        return jsonify({"message": "Podcast added to playlist successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route('/playlist/<playlist_id>', methods=['DELETE'])
@token_required
def remove_from_playlist(playlist_id):
    try:
        data = request.json
        podcast_id = data.get("podcast_id")
        if not podcast_id:
            return jsonify({"message": "no podcast id provided"}), 400
        delete_from_playlist(playlist_id, podcast_id)
        return jsonify({"message": "Podcast removed from playlist successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/playing', methods=['POST'])
@token_required
def get_playing():
    try:
        user_id = request.environ.get("USER_ID")
        data = request.json
        position = data.get("position", 0)
        podcast_id = data.get("podcast_id", None)
        if not podcast_id:
            return jsonify({"message": "no podcast id provided"}), 400
        update_user_listen_position(user_id, podcast_id, position)
        return jsonify({"message": "Playing successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/played', methods=['POST'])
@token_required
def mark_as_played():
    try:
        user_id = request.environ.get("USER_ID")
        data = request.json
        user_activity_log(user_id, data)
        return jsonify({"message": "Marked as played successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

app.add_url_rule(
    "/graphql",
    view_func=token_required(GraphQLView.as_view("graphql_view", schema=schema, graphiql=True))
)


if __name__ == "__main__":
    threading.Thread(target=run_scheduler, daemon=True).start()
    app.run(host="0.0.0.0", port=5002)
