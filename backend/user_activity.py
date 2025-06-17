import numpy as np
import sys
import os

# Add the parent directory to the Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime, timedelta
from constant.history_weight import get_weight, batch_size, dim_weight, listen_weight, compute_completeness
from db.db import update_user_batch_embedding, update_user_daily_embedding, update_user_daily_embedding, update_user_batch_embedding, get_complete_user_history, get_podcast_embeddings, add_to_listening_history, update_realtime_embedding, update_prevday_embedding, get_user_last_daily_update
from cuda_stuff import embed_text


def search(user_id, query):
    embedding = embed_text([query])
    embedding = embedding['dense'][0]
    weight = get_weight(["search"])
    _update_user_batch_embedding(user_id, embedding, weight)
    _update_user_daily_embedding(user_id, embedding, weight)
    return True

def user_activity_log(user_id, actions):
    podcast_id = actions['podcast_id']
    embedding = get_podcast_embeddings([podcast_id])
    if embedding:
        embedding = np.array(embedding[0])
        print(embedding.shape, flush=True)
        percentage = compute_completeness(actions['last_position'], actions['total_duration_seconds'])
        action_set = set()
        for action in actions['actions']:
            action_set.add(action['action'])
        weight = min(get_weight(action_set) + listen_weight(percentage), 3)
        complete_history = get_complete_user_history(user_id, podcast_ids=[podcast_id])
        replay = 0
        for history in complete_history:
            if not history['hidden']:
                replay = history['play_count']
                break
        weight = dim_weight(weight, replay)
        if 'auto_play' in actions and actions['auto_play']:
            if weight == 1:
                weight = 0.5   
        user_activity = {
            "listen_duration_seconds": actions['listen_duration_seconds'],
            "stop_position_seconds": actions['last_position'],
            "share_count": 1 if 'share' in action_set else 0,
            "download_count": 1 if 'download' in action_set else 0,
            "add_to_playlist": 1 if 'add_to_playlist' in action_set else 0,
            "rating": actions['rating'] if 'rating' in action_set else 0
        }

        _update_user_batch_embedding(user_id, embedding, weight)
        _update_user_daily_embedding(user_id, embedding, weight)
        add_to_listening_history(user_id, podcast_id, user_activity, completed=percentage >= 0.9)
        return True
    return False



def _update_user_batch_embedding(user_id, embedding, weight):
    batch_count = update_user_batch_embedding(user_id, embedding, weight)
    if batch_count >= 0 and batch_count >= batch_size:
        return update_realtime_embedding(user_id)
    if batch_count >= 0 and batch_count < batch_size:
        return True
    return False

def _update_user_daily_embedding(user_id, embedding, weight):
    time = update_user_daily_embedding(user_id, embedding, weight)
    if time is None:
        return False
    return recompute_user_daily_embedding(user_id)

def recompute_user_daily_embedding(user_id):
    time = get_user_last_daily_update(user_id)
    if time is not None and datetime.now() - datetime.fromtimestamp(time) > timedelta(days=1):
        return update_prevday_embedding(user_id)
    return True