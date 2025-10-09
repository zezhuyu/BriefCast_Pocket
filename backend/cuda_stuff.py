from dotenv import load_dotenv
import os
from kokoro import KPipeline
from pydub import AudioSegment
from pymilvus.model.hybrid import BGEM3EmbeddingFunction
from io import BytesIO
import numpy as np
import torch
import io
import ffmpeg
import openai
import re
import warnings
import openai
import nltk
from nltk.tokenize import sent_tokenize
import gc
from contextlib import contextmanager
from db.cache import HybridLock

nltk_data_path = os.path.join(os.path.expanduser("~"), "nltk_data")
nltk.download('punkt', download_dir=nltk_data_path)
nltk.download('punkt_tab', download_dir=nltk_data_path)
nltk.data.path.append(nltk_data_path)

_embedding_lock = HybridLock()

load_dotenv()

warnings.filterwarnings('ignore')

LOCAL_AUDIO = os.getenv('LOCAL_AUDIO', "True") == "True"
openai.api_key = os.getenv('OPENAI_API_KEY', 'ollama')
openai.base_url = os.getenv('OPENAI_API_URL', "http://localhost:11434/v1/")
TEXT_MODEL = os.getenv('TEXT_MODEL', "gemma3n")

EMBEDDING_MODEL = os.getenv('EMBEDDING_MODEL', "BAAI/bge-m3")

DEVICE = "cpu"
if torch.backends.mps.is_available():
    DEVICE = "mps"
elif torch.cuda.is_available():
    DEVICE = "cuda"

bge_m3_ef = None

def clear_cache():
    global DEVICE
    if DEVICE == "mps":
        torch.mps.empty_cache()
    elif DEVICE == "cuda":
        torch.cuda.empty_cache()
    gc.collect()

@contextmanager
def embedding_model():
    global bge_m3_ef
    clear_cache()
    try:
        if bge_m3_ef is None:
            bge_m3_ef = BGEM3EmbeddingFunction(model_name=EMBEDDING_MODEL, device=DEVICE, use_fp16=False)
        yield bge_m3_ef
    finally:
        bge_m3_ef = None
        clear_cache()
        

def embed_text(text):
    # with _embedding_lock:
    clear_cache()
    embedding = bge_m3_ef.encode_documents(text)
    clear_cache()
    return embedding

def chat_text(messages):
    response = openai.chat.completions.create(
        model=TEXT_MODEL,
        messages=messages
    )
    return response.choices[0].message.content.strip()

def format_timestamp(seconds):
    """Convert seconds to LRC timestamp format [mm:ss.xx]"""
    minutes = int(seconds // 60)
    sec = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 100)
    return f"[{minutes:02}:{sec:02}.{millis:02}]"

def split_nltk(text):
    return sent_tokenize(text)

def create_audio_openai(audio_text, voice="alloy", split_pattern=r"\s*,\s*"):
    if voice == 'bm_george':
        voice = 'alloy'
    elif voice == 'af_heart':
        voice = 'nova'
    parts = split_nltk(audio_text)
    
    start_time = 0.0
    combined_audio = AudioSegment.silent(duration=0)
    lyric = []

    # for i, sentence in enumerate(parts):
    response = openai.audio.speech.create(
        model="tts-1",
        voice=voice,
        input=audio_text
    )

    audio = AudioSegment.from_file(BytesIO(response.content), format="mp3")
    duration = audio.duration_seconds

    timestamp = format_timestamp(start_time)
    lyric.append(f"{timestamp}{audio_text}")
    start_time += duration

    audio = audio.set_frame_rate(48000).set_channels(2)
    combined_audio += audio

    audio_buffer = BytesIO()
    combined_audio.export(audio_buffer, format="wav")
    audio_buffer.seek(0)

    return audio_buffer, lyric

def create_audio_kokoro(audio_text, voice='am_michael', split_pattern=r'\s*,\s*'):
    clear_cache()
    audio_pipeline = KPipeline(repo_id=AUDIO_MODEL, lang_code='a', device=DEVICE)
    # sentences = split_nltk(audio_text)
    start_time = 0.0
    combined_audio = AudioSegment.silent(duration=0)
    lyric = []
    # for sentence in sentences:
    generator = audio_pipeline(
        audio_text, voice=voice, # 'af_heart', 'af_bella', 'bm_george', 'am_adam', 'af_nicole'
        speed=1
    )
    
    for i, (gs, ps, audio) in enumerate(generator):
        duration = len(audio) / 24000  
        timestamp = format_timestamp(start_time)
        gs = gs.replace("\n", " ").rstrip(" \t\n").rstrip(" \n\t").rstrip(".,!?")
        lyric.append(f"{timestamp}{gs}")
        start_time += duration  
        audio_np = audio.cpu().numpy()
        if audio_np.dtype == np.float32:
            audio_np = np.int16(audio_np * 32767)
        
        segment = AudioSegment(
            data=audio_np.tobytes(), 
            sample_width=audio_np.dtype.itemsize, 
            frame_rate=24000, 
            channels=1
        )

        segment = segment.set_frame_rate(48000)
        segment = segment.set_channels(2)
        
        combined_audio += segment

    audio_buffer = BytesIO()
    combined_audio.export(audio_buffer, format="wav")
    audio_buffer.seek(0)
    audio_pipeline = None
    clear_cache()
    return audio_buffer, lyric

def compress_audio(audio):
    audio.seek(0)
    compressed_audio = io.BytesIO()
    process=(ffmpeg.input('pipe:0').output('pipe:1', format='mp3', audio_bitrate='32k', ac=1, ar=16000).run(input=audio.read(), capture_stdout=True, capture_stderr=True))
    compressed_audio.write(process[0])
    compressed_audio.seek(0)
    return compressed_audio

def get_audio_duration(wav_bytes_io):
    """Get the duration of a WAV file in seconds from a BytesIO object."""
    audio_segment = AudioSegment.from_file(wav_bytes_io)
    duration = len(audio_segment) / 1000
    return duration

def convert_time_to_seconds(time_str):
    """Convert a time in mm:ss.xx format to total seconds."""
    minutes, seconds = time_str.split(':')
    seconds, milliseconds = seconds.split('.')
    total_seconds = int(minutes) * 60 + int(seconds) + int(milliseconds) / 100
    return total_seconds

def convert_seconds_to_time(seconds):
    """Convert total seconds to mm:ss.xx format."""
    minutes = int(seconds) // 60
    seconds_remaining = seconds % 60
    seconds_int = int(seconds_remaining)
    milliseconds = int((seconds_remaining - seconds_int) * 100)
    return f"[{minutes:02d}:{seconds_int:02d}.{milliseconds:02d}]"

def modify_timestamp(line, add_seconds):
    """Modify the timestamp in the given line by adding a value in seconds."""
    # Find the timestamp in the format [mm:ss.xx]
    match = re.search(r'\[(\d{2}:\d{2}\.\d{2})\]', line)
    if match:
        time_str = match.group(1)
        # Convert time to seconds, add the value, and convert back to time
        total_seconds = convert_time_to_seconds(time_str)
        modified_seconds = total_seconds + add_seconds
        modified_time_str = convert_seconds_to_time(modified_seconds)
        # Replace the original timestamp with the modified one
        modified_line = line.replace(time_str, modified_time_str[1:-1])  # Strip the brackets from time_str
        return modified_line
    else:
        return line
    
if LOCAL_AUDIO:
    from kokoro import KPipeline
    AUDIO_MODEL = os.getenv('AUDIO_MODEL', "hexgrad/Kokoro-82M")
    create_audio = create_audio_kokoro
else:
    import openai
    openai.api_key = os.getenv('OPENAI_API_KEY')
    AUDIO_MODEL = os.getenv('AUDIO_MODEL', "tts-1")
    create_audio = create_audio_openai