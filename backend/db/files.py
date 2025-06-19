import os
from io import BytesIO
import shutil
import uuid
from datetime import datetime
from nanoid import generate
from cuda_stuff import compress_audio
import sys

current_file_dir = os.path.join(os.path.expanduser("~"), "BriefCast_data")
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE_DIR = os.path.join(current_file_dir, "data")

def store_content(content):
    id = generate(size=16)
    filename = f"content/{id}.txt"
    path = os.path.join(BASE_DIR, filename)
    with open(path, "w") as f:
        f.write(content)
    return filename

def store_image(image):
    image_buffer = BytesIO()
    image.save(image_buffer, format='JPEG', quality=30, optimize=True)
    image_buffer.seek(0)
    id = generate(size=16)
    filename = f"image/{id}.jpg"
    path = os.path.join(BASE_DIR, filename)
    with open(path, "wb") as f:
        f.write(image_buffer.getvalue())
    return filename

def store_audio(audio):
    audio.seek(0)
    audio = compress_audio(audio)
    audio.seek(0)
    id = generate(size=16)
    filename = f"audio/{id}.mp3"
    path = os.path.join(BASE_DIR, filename)
    with open(path, "wb") as f:
        f.write(audio.getvalue())
    return filename

def store_transcript(transcript):
    id = generate(size=16)
    filename = f"transcript/{id}.lrc"
    path = os.path.join(BASE_DIR, filename)
    with open(path, "w") as f:
        for line in transcript:
            f.write(line  + "\n")
    return filename

def store_script(script):
    id = generate(size=16)
    filename = f"script/{id}.txt"
    path = os.path.join(BASE_DIR, filename)
    with open(path, "w") as f:
        f.write(script)
    return filename

def get_file(filename):
    path = os.path.join(BASE_DIR, filename)
    with open(path, "rb") as f:
        return BytesIO(f.read())

def delete_file(filename):
    if filename is None or filename == "":
        return False
    path = os.path.join(BASE_DIR, filename)
    if os.path.exists(path):
        os.remove(path)
    return True
