from db.db import store_podcast_audio, store_podcast_transcript, get_podcast_content, get_podcast_transcript, get_podcast_audio, get_podcast_script, store_podcast_script, get_podcasts, get_podcast, create_summary_podcast, add_to_listening_history
from script import rewrite_podcast, create_transition, create_weather_forecast, summarize_news, create_news_title
from cuda_stuff import create_audio, modify_timestamp, get_audio_duration
from db.files import store_transcript, store_audio, get_file
from crawler.news_crawler import news_crawler
import re
from zoneinfo import ZoneInfo
from datetime import datetime
from timezonefinder import TimezoneFinder 
from pydub import AudioSegment
import requests
import wave
import io
import hashlib
import numpy as np
from cuda_stuff import compress_audio
import asyncio
from db.cache import store
from cuda_stuff import embedding_model
import gc
from tqdm import tqdm

async def create_summary_script(pids):
    contents = []
    podcasts = get_podcasts(pids)
    if podcasts is None:
        return None
    await news_crawler(podcasts)
    for podcast in podcasts:
        content = get_podcast_content(podcast['id'])
        if content is None:
            continue
        contents.append(content)
    for _ in range(3):
        try:
            summary = summarize_news(contents)  
            if summary:
                break
        except Exception:
            pass
    for _ in range(3):
        try:
            script = rewrite_podcast(summary)
            if script:
                break
        except Exception:
            pass
    gc.collect()
    return script
    
async def create_daily_summary(pids):
    if store.sismember("daily_summary", "".join(pids)):
        print("Daily summary already exists")
        return None, None, None
    store.sadd("daily_summary", "".join(pids))
    try:
        script = await create_summary_script(pids)
        if script is None:
            return None, None, None
        new_lyric = []
        split_pattern = r'[.:]\s+'
        sentences = re.split(split_pattern, script)
        audio_text = ""
        for text in sentences:
            if text:
                audio_text += text + ", "
        audio, lyric = create_audio(audio_text, voice='bm_george')
        for line in lyric:
            new_lyric.append(modify_timestamp(line, 0))
        duration = get_audio_duration(audio)
        audio.seek(0)
        store.srem("daily_summary", "".join(pids))
        gc.collect()
        return audio, new_lyric, duration
    except Exception as e:
        print("daily summary error: ", e)
        store.srem("daily_summary", "".join(pids))
        gc.collect()
        return None, None, None

def generate_id(ids_list, length=None):
    ids_list = sorted(ids_list)
    combined = ",".join(str(x) for x in ids_list)
    hash_digest = hashlib.sha256(combined.encode()).hexdigest()
    if not length:
        length = max(len(str(x)) for x in ids_list)
    return hash_digest[:length]

async def create_news_summary_podcast(user_id, pids):
    pid = generate_id(pids)
    if store.sismember("summary_podcast", pid):
        print("Summary podcast already exists")
        return None
    store.sadd("summary_podcast", pid)
    try:
        audio, lyric, duration = await create_daily_summary(pids)
        if audio is None:
            return None
        audio_url = store_audio(audio)
        transcript_url = store_transcript(lyric)
        podcasts = get_podcasts(pids)
        titles = [podcast['title'] for podcast in podcasts]
        title = create_news_title("\n".join(titles))
        with embedding_model():
            create_summary_podcast(user_id, pid, pids, title, audio_url, transcript_url, duration)
        for p in pids:
            add_to_listening_history(user_id, p, {}, hidden=True)
        store.srem("summary_podcast", pid)
        gc.collect()
        return pid
    except Exception as e:
        print(e)
        store.srem("summary_podcast", pid)
        gc.collect()
        return None

async def create_transcript(pid):
    podcast = get_podcast(pid)
    if podcast and podcast['title'].startswith("Briefcast Daily News "):
        return "Briefcast Daily News"
    if podcast and podcast['image_url'] == "image/summary.png":
        return "Briefcast News Summary"
    script = get_podcast_script(pid)
    if script is not None:
        return script
    podcast = get_podcast(pid)
    if podcast is None:
        return None
    await news_crawler([podcast])
    content = get_podcast_content(pid)
    if content is None:
        return None
    for _ in range(3):
        try:
            script = rewrite_podcast(content)
            if script:
                break
        except Exception as e:
            pass
    store_podcast_script(pid, script)
    return script


async def create_podcast(pid):
    if store.sismember("podcast", pid):
        print("Podcast already exists")
        return None, None, None
    store.sadd("podcast", pid)
    try:
        audio = get_podcast_audio(pid)
        lyric = get_podcast_transcript(pid)
        if audio is not None:
            return audio, lyric, get_audio_duration(audio)
        script = await create_transcript(pid)
        if script is None:
            return None, None, None
        new_lyric = []
        split_pattern = r'[.:]\s+'
        sentences = re.split(split_pattern, script)
        audio_text = ""
        for text in sentences:
            if text:
                audio_text += text + ", "
        audio, lyric = create_audio(audio_text, voice='bm_george')
        for line in lyric:
            new_lyric.append(modify_timestamp(line, 0))
        duration = get_audio_duration(audio)
        audio.seek(0)
        store_podcast_transcript(pid, new_lyric)
        store_podcast_audio(pid, audio, duration)
        store.srem("podcast", pid)
        gc.collect()
        return audio, new_lyric, duration
    except Exception as e:
        print("podcast error: ", e)
        store.srem("podcast", pid)
        gc.collect()
        return None, None, None
    

def mix_wav_with_delay(background_wav, greeting_wav, opening_wav, starting_wav, forecast_wav=None, bg_volume=0.1, delay_sec=31, fade_duration_sec=1, start_volume=0.6):
    """Mix background music with speech, applying a volume change for the beginning part and fade-in effect."""
    
    # Open both WAV files
    with wave.open(background_wav, 'rb') as bg, wave.open(greeting_wav, 'rb') as greeting, wave.open(opening_wav, 'rb') as opening:
        # Ensure both have the same parameters (channels, sample width, framerate)
        if (bg.getnchannels() != greeting.getnchannels() or 
            bg.getsampwidth() != greeting.getsampwidth() or 
            bg.getframerate() != greeting.getframerate()):
            raise ValueError("WAV files must have the same format")

        # Read frames as NumPy arrays
        bg_frames = np.frombuffer(bg.readframes(bg.getnframes()), dtype=np.int16)
        greeting_frames = np.frombuffer(greeting.readframes(greeting.getnframes()), dtype=np.int16)
        opening_frames = np.frombuffer(opening.readframes(opening.getnframes()), dtype=np.int16)

        # Convert delay to number of samples
        sample_rate = bg.getframerate()
        delay_samples = int(delay_sec * sample_rate * bg.getnchannels())

        # Pad speech with silence at the beginning
        silence = np.zeros(delay_samples, dtype=np.int16)
        one_second_silence = np.zeros(int(0.5 * sample_rate * bg.getnchannels()), dtype=np.int16)
        speech_frames = np.concatenate((silence, greeting_frames, one_second_silence, opening_frames))

        soft_delay = delay_samples
        if delay_sec > (fade_duration_sec + 0.1):
            soft_delay = int((delay_sec - (fade_duration_sec + 0.1)) * sample_rate * bg.getnchannels())

        # Split the background music frames:
        bg_before_delay = bg_frames[:soft_delay]  # No fade during the delay period
        bg_after_delay = bg_frames[soft_delay:].copy()  # Copy to ensure it's mutable

        # Apply the initial volume change for the first part of the background music
        bg_before_delay = bg_before_delay * start_volume  # Adjust the volume for the initial part

        # Apply fade-in effect for 1 second (fade_duration_sec)
        fade_samples = int(fade_duration_sec * sample_rate * bg.getnchannels())  # Number of samples for the fade

        # Apply a quadratic fade-in (soft start, faster towards the end)
        fade_in_curve = np.linspace(start_volume, bg_volume, fade_samples)

        # Ensure no mute by applying fade-in curve from the beginning of bg_after_delay
        if len(bg_after_delay) > fade_samples:
            bg_after_delay[:fade_samples] = (bg_after_delay[:fade_samples] * fade_in_curve).astype(np.int16)
        else:
            bg_after_delay = (bg_after_delay * fade_in_curve).astype(np.int16)

        # Once the fade-in completes, apply the bg_volume for the remainder of the audio
        bg_after_fade = bg_after_delay[fade_samples:]
        bg_after_fade = bg_after_fade * bg_volume  # Ensure background music stays at the desired volume

        # Concatenate the parts of the background music back together
        bg_frames = np.concatenate((bg_before_delay, bg_after_delay[:fade_samples], bg_after_fade))

        # Determine the final length (longest file should be kept)
        max_len = max(len(bg_frames), len(speech_frames))

        # Extend both arrays to match the longest one (fill with silence if needed)
        if len(bg_frames) < max_len:
            bg_frames = np.pad(bg_frames, (0, max_len - len(bg_frames)), 'constant', constant_values=0)
        if len(speech_frames) < max_len:
            speech_frames = np.pad(speech_frames, (0, max_len - len(speech_frames)), 'constant', constant_values=0)

        # Mix the audio: sum the background music with speech
        mixed_audio = (speech_frames + bg_frames).astype(np.int16)

        # Create a new BytesIO object to store the mixed audio
        mixed_wav = io.BytesIO()
        with wave.open(mixed_wav, 'wb') as output:
            output.setnchannels(bg.getnchannels())
            output.setsampwidth(bg.getsampwidth())
            output.setframerate(sample_rate)
            output.writeframes(mixed_audio.tobytes())
            if forecast_wav:
                with wave.open(forecast_wav, 'rb') as forecast:
                    output.writeframes(forecast.readframes(forecast.getnframes()))
            with wave.open(starting_wav, 'rb') as starting:
                output.writeframes(starting.readframes(starting.getnframes()))

    mixed_wav.seek(0)  # Reset pointer to the start
    return mixed_wav

def mix_wav_with_fade_in_and_speech_control(bg_wav, speech_wav, bg_speech=0.6, bg_music=0.6, delay_sec=20, fade_duration_sec=1):
    """Play speech first, then fade in background music from 0 to bg_music over a specified duration, and adjust volume based on speech or music."""
    
    # Read the background music WAV from the BytesIO object
    with wave.open(bg_wav, 'rb') as bg:
        # Get background music parameters
        bg_channels = bg.getnchannels()
        bg_sampwidth = bg.getsampwidth()
        bg_framerate = bg.getframerate()
        bg_frames = np.frombuffer(bg.readframes(bg.getnframes()), dtype=np.int16)
        
    # Read the speech WAV from the BytesIO object
    with wave.open(speech_wav, 'rb') as speech:
        # Get speech parameters
        speech_channels = speech.getnchannels()
        speech_sampwidth = speech.getsampwidth()
        speech_framerate = speech.getframerate()
        speech_frames = np.frombuffer(speech.readframes(speech.getnframes()), dtype=np.int16)

    # Ensure both WAV files have the same parameters
    if (bg_channels != speech_channels or bg_sampwidth != speech_sampwidth or bg_framerate != speech_framerate):
        raise ValueError("WAV files must have the same format")

    # Convert delay to number of samples
    sample_rate = bg_framerate
    delay_samples = int(delay_sec * sample_rate * bg_channels)

    # Pad speech with silence at the beginning
    silence = np.zeros(delay_samples, dtype=np.int16)
    speech_frames_padded = np.concatenate((silence, speech_frames))

    # Fade-in the background music from volume 0 to bg_music at the start
    fade_samples = int(fade_duration_sec * sample_rate * bg_channels)  # Number of samples for the fade

    # Create a fade-in curve from 0 to bg_music
    fade_in_curve = np.linspace(0, bg_music, fade_samples)

    # Apply fade-in effect to the first part of the background music
    bg_fade_in = bg_frames[:fade_samples] * fade_in_curve
    bg_after_fade_in = bg_frames[fade_samples:] * bg_music  # Ensure remaining audio is at bg_music volume

    # Concatenate the faded background music
    bg_frames = np.concatenate((bg_fade_in, bg_after_fade_in))

    # Now adjust the volume for when the speech is playing (bg_speech)
    speech_end_sample = len(speech_frames_padded)
    bg_after_speech_start = bg_frames[speech_end_sample:]

    # Mix speech with background music at bg_speech volume during speech
    bg_during_speech = bg_frames[:speech_end_sample] * bg_speech

    # Make sure both arrays have the same length (pad if needed)
    max_len = max(len(speech_frames_padded), len(bg_during_speech))
    
    if len(speech_frames_padded) < max_len:
        speech_frames_padded = np.pad(speech_frames_padded, (0, max_len - len(speech_frames_padded)), 'constant', constant_values=0)
    
    if len(bg_during_speech) < max_len:
        bg_during_speech = np.pad(bg_during_speech, (0, max_len - len(bg_during_speech)), 'constant', constant_values=0)

    # Mix the audio: the speech part will be combined with the adjusted background music (at bg_speech volume)
    mixed_audio = (speech_frames_padded + bg_during_speech).astype(np.int16)

    # After speech, the background music should continue playing at bg_music volume
    mixed_audio = np.concatenate((mixed_audio, bg_after_speech_start * bg_music))

    # Prevent clipping by ensuring the mixed_audio doesn't exceed the int16 range
    mixed_audio = np.clip(mixed_audio, -32768, 32767).astype(np.int16)

    # Create a new BytesIO object to store the mixed audio
    mixed_wav = io.BytesIO()
    with wave.open(mixed_wav, 'wb') as output:
        output.setnchannels(bg_channels)
        output.setsampwidth(bg_sampwidth)
        output.setframerate(sample_rate)
        output.writeframes(mixed_audio.tobytes())

    mixed_wav.seek(0)  # Reset pointer to the start
    return mixed_wav

def get_ordinal_suffix(day):
    if 11 <= day <= 13:  # Special case for 11th, 12th, 13th
        return f"{day}th"
    last_digit = day % 10
    if last_digit == 1:
        return f"{day}st"
    elif last_digit == 2:
        return f"{day}nd"
    elif last_digit == 3:
        return f"{day}rd"
    else:
        return f"{day}th"
    
def get_greeting(time=None):
    if time is None:
        return "Good morning!"
    hour = time.hour
    if 5 <= hour < 12:
        return "Good morning!"
    elif 12 <= hour < 17:
        return "Good afternoon!"
    elif 17 <= hour < 21:
        return "Good evening!"
    else:
        return "Good night!"

def create_opening(location=None):

    url = "https://wttr.in/"
    speech_delay = 31

    new_lyric = []

    bg_wav = get_file("audio/op.wav")
    starting_audio = get_file("audio/starting.wav")
    starting_lyric = get_file("transcript/starting.lrc").getvalue().decode("utf-8").splitlines()
    opening_lyric = get_file("transcript/opening.lrc").getvalue().decode("utf-8").splitlines()
    opening_audio = get_file("audio/opening.wav")

    if location and (location != [None, None] and location != [0, 0] or len(location.split(',')) == 2):
        Latitude, Longitude = map(float, location.split(','))
        obj = TimezoneFinder()
        timezone = obj.certain_timezone_at(lng=Longitude, lat=Latitude)
        timezone = ZoneInfo(timezone)
        localized_time = datetime.now(timezone)
        try:
            response = requests.get(f"{url}{Latitude:.2f},{Longitude:.2f}?FT1")
        except Exception as e:
            print(e)
            response = None
    else:
        localized_time = datetime.now()

    today = localized_time.date()

    greeting = get_greeting(localized_time)
    weekday = today.strftime("%A")
    month = today.strftime("%B")
    day = today.day
    year = today.year

    day = get_ordinal_suffix(day)

    add_seconds = speech_delay

    welcome = f"{greeting} Today is {weekday} {month} {day} {year}."
    greeting_audio, greeting_lyric = create_audio(welcome, voice='af_heart', split_pattern=r'\.+')
    for line in greeting_lyric:
        new_lyric.append(modify_timestamp(line, add_seconds))
    add_seconds += get_audio_duration(greeting_audio)
    greeting_audio.seek(0)

    for line in opening_lyric:
        new_lyric.append(modify_timestamp(line, add_seconds))
    add_seconds = max(get_audio_duration(bg_wav), add_seconds)
    bg_wav.seek(0)
    forecast_audio = None
    if location and location != [None, None] and location != [0, 0] and response:
        forecast = create_weather_forecast(response.text)
        split_pattern = r'[.:]\s+'
        sentences = re.split(split_pattern, forecast)
        audio_text = ""
        for text in sentences:
            if text:
                audio_text += text + ", "
        forecast_audio, forecast_lyric = create_audio(audio_text, voice='af_heart', split_pattern=r'\s*,\s*')
        for line in forecast_lyric:
            new_lyric.append(modify_timestamp(line, add_seconds))
        add_seconds += get_audio_duration(forecast_audio)
        forecast_audio.seek(0)

    for line in starting_lyric:
        new_lyric.append(modify_timestamp(line, add_seconds))
    add_seconds += get_audio_duration(starting_audio)
    starting_audio.seek(0)

    mixed_wav = mix_wav_with_delay(bg_wav, greeting_audio, opening_audio, starting_audio, forecast_wav=forecast_audio, delay_sec=speech_delay)
    mixed_wav.seek(0)

    return compress_audio(mixed_wav), new_lyric, add_seconds

def create_ending(add_seconds=0):
    speech_delay = 3.5

    bg_wav = get_file("audio/ed.wav")
    ending_audio = get_file("audio/ending.wav")
    ending_lyric = get_file("transcript/ending.lrc").getvalue().decode("utf-8").splitlines()


    new_lyric = []
    add_seconds += speech_delay

    for line in ending_lyric:
        new_lyric.append(modify_timestamp(line, add_seconds))
    add_seconds += get_audio_duration(ending_audio)
    ending_audio.seek(0)

    mixed_wav = mix_wav_with_fade_in_and_speech_control(bg_wav, ending_audio, delay_sec=speech_delay)
    mixed_wav.seek(0)

    return compress_audio(mixed_wav), new_lyric, add_seconds

async def create_transition_audio(id1, id2):
    if store.sismember("transition_audio", f"{id1}{id2}"):
        print("Transition task already exists")
        return None, None, None
    store.sadd("transition_audio", f"{id1}_{id2}")
    try:
        script1 = await create_transcript(id1)
        script2 = await create_transcript(id2)
        if script1 is None or script2 is None:
            return None, None, None
        for _ in range(3):
            try:
                transition = create_transition(script1, script2)
                if transition:
                    break
            except Exception:
                pass
        new_lyric = []
        split_pattern = r'[.:]\s+'
        sentences = re.split(split_pattern, transition)
        audio_text = ""
        for text in sentences:
            if text:
                audio_text += text + ", "
        audio, lyric = create_audio(audio_text, voice='af_heart')
        for line in lyric:
            new_lyric.append(modify_timestamp(line, 0))
        duration = get_audio_duration(audio)
        audio.seek(0)
        audio = compress_audio(audio)
        audio.seek(0)
        store.srem("transition_audio", f"{id1}{id2}")
        gc.collect()
        return audio, new_lyric, duration
    except Exception as e:
        print("transition audio error: ", e)
        store.srem("transition_audio", f"{id1}{id2}")
        gc.collect()
        return None, None, None
    

async def store_transition_audio(id1, id2):
    if store.sismember("transition_services", f"{id1}{id2}"):
        print("Transition services already exists")
        return None, None, None
    store.sadd("transition_services", f"{id1}{id2}")
    try:
        audio, new_lyric, duration = await create_transition_audio(id1, id2)
        if audio is None:
            return None, None, None
        transcript_url = store_transcript(new_lyric)
        audio_url = store_audio(audio)
        store.set(f"{id1}:{id2}", {
            "audio_url": audio_url,
            "transcript_url": transcript_url,
            "duration": duration
        }, ttl=60 * 60 * 24)
        store.srem("transition_services", f"{id1}{id2}")
        gc.collect()
        return audio_url, transcript_url, duration
    except Exception as e:
        print(e)
        store.srem("transition_services", f"{id1}{id2}")
        gc.collect()
        return None, None, None

def create_silence(secs, audio_sample=None):
    channels = 2
    width = 2
    frame_rate = 44100
    if audio_sample:
        with wave.open(audio_sample, 'rb') as audio:
            channels = audio.getnchannels()
            width = audio.getsampwidth()
            frame_rate = audio.getframerate()
    silence = io.BytesIO()
    with wave.open(silence, 'wb') as audio_file:
        audio_file.setnchannels(channels)
        audio_file.setsampwidth(width)
        audio_file.setframerate(frame_rate)
        audio_file.writeframes(np.zeros(int(secs * frame_rate * channels), dtype=np.int16).tobytes())
    silence.seek(0)
    return silence
    

async def generate_daily_news(pids, location=None, silence_secs=1, summary=False):
    lyrics = []
    news = []
    times = []
    opening_audio, opening_lyric, add_seconds = create_opening(location)
    add_seconds += silence_secs
    news.append(opening_audio)
    news.append(create_silence(silence_secs))
    lyrics.append(opening_lyric)
    times.append(add_seconds)
    if summary:
        audio, lyric, add_seconds = await create_daily_summary(pids)
        add_seconds += silence_secs
        news.append(audio)
        lyrics.append(lyric)
        times.append(add_seconds)
        news.append(create_silence(silence_secs))
    else:
        id1 = None
        id2 = None
        for pid in tqdm(pids):
            audio, lyric, add_seconds = await create_podcast(pid)
            if audio is None:
                continue
            id2 = pid
            add_seconds += silence_secs
            if id1 is not None:
                transition_audio, transition_lyric, transition_secs = await create_transition_audio(id1, id2)
                transition_secs += silence_secs
                times.append(transition_secs)
                news.append(transition_audio)
                news.append(create_silence(silence_secs))
                lyrics.append(transition_lyric)
            news.append(audio)
            news.append(create_silence(silence_secs))
            lyrics.append(lyric)
            times.append(add_seconds)
            id1 = id2
    ending_audio, ending_lyric, add_seconds = create_ending()
    news.append(ending_audio)
    lyrics.append(ending_lyric)
    times.append(add_seconds)
    return news, lyrics, times


def apply_times(lyrics, times):
    new_lyric = []
    add_seconds = 0
    for i in range(len(lyrics)):
        for line in lyrics[i]:
            new_lyric.append(modify_timestamp(line, add_seconds))
        add_seconds += times[i]
    return new_lyric

def safe_load_audio(audio_bytes_io: io.BytesIO):
    audio_bytes_io.seek(0)
    header = audio_bytes_io.read(10)
    audio_bytes_io.seek(0)

    if header.startswith(b'RIFF'):
        return AudioSegment.from_file(audio_bytes_io, format="wav")
    elif header.startswith(b'ID3') or header[0:1] == b'\xff':
        return AudioSegment.from_file(audio_bytes_io, format="mp3")
    else:
        raise ValueError("Unsupported or corrupt audio format.")
    
def combine_audio(news):
    combined = None
    for audio_io in news:
        segment = safe_load_audio(audio_io)
        if combined is None:
            combined = segment
        else:
            combined += segment
    if combined is None:
        raise ValueError("No audio data provided.")
    output = io.BytesIO()
    combined.export(output, format="wav")
    output.seek(0)
    return compress_audio(output)

def combine_lyrics(lyrics):
    lyric_path = io.BytesIO()
    lyric_text = '\n'.join(lyrics)
    lyric_path.write(lyric_text.encode('utf-8'))
    lyric_path.seek(0)
    return lyric_path

    
