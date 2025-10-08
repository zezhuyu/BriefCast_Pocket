import math
import numpy as np

weight = {
    "80%": 1,
    "50%": 0.5,
    "30%": 0,
    "0%": -0.5,
    "like": 1,
    "dislike": -1,
    "share": 1.8,
    "download": 1.3,
    "add_to_playlist": 1.4,
    "search": 0.75,
}

batch_size = 10

def dim_weight(weight, replay):
    replay = max(replay, 1)
    return weight * (1 / math.e ** (replay - 1))

def get_weight(actions):
    total_weight = 0
    for action in actions:
        if action in weight:
            total_weight += weight[action]
    return total_weight


def get_embeding_mean(embedding, number):
    if number == 0:
        return embedding
    result = embedding / number
    # Check for NaN values and replace with zeros if found
    if np.isnan(result).any():
        return np.zeros_like(embedding)
    return result

def normalize_embedding(embedding):
    norm = np.linalg.norm(embedding)
    if norm == 0 or np.isnan(norm):
        return np.zeros_like(embedding)
    result = embedding / norm
    # Check for NaN values and replace with zeros if found
    if np.isnan(result).any():
        return np.zeros_like(embedding)
    return result

def compute_daily_embedding(privous, current):
    result = privous * 0.8 + current * 0.2
    # Check for NaN values and replace with zeros if found
    if np.isnan(result).any():
        return np.zeros_like(privous)
    return result

def compute_batch_embedding(privous, current):
    result = privous * 0.9 + current * 0.1
    # Check for NaN values and replace with zeros if found
    if np.isnan(result).any():
        return np.zeros_like(privous)
    return result

def listen_weight(percentage):
    if percentage < 0.05:
        return 0
    elif percentage < 0.3:
        return weight["0%"]
    elif percentage < 0.5:
        return weight["30%"]
    elif percentage < 0.8:
        return weight["50%"]
    elif percentage >= 0.8:
        return weight["80%"]
    else:
        return weight["0%"]


def compute_completeness(stop_position, duration):
    return stop_position / duration

def real_listen_time(listen_duration, stop_position):
    return listen_duration / stop_position

