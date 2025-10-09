import warnings
import os
import sys

# Add the parent directory to the Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cuda_stuff import chat_text    
from constant.prompt import SYSTEMP_PROMPT_SUMMARY, SYSTEMP_PROMPT_WRITER, SYSTEMP_PROMPT_REWRITER_2, SYSTEMP_PROMPT_TRANSITION, SYSTEMP_PROMPT_WEATHER, SYSTEMP_PROMPT_NEWS_TITLE

warnings.filterwarnings('ignore')

def summarize_news(news):
    if news == "":
        raise Exception("news must not be empty")
    messages = [
        {"role": "system", "content": SYSTEMP_PROMPT_SUMMARY},
    ]
    for news_item in news:
        messages.append({"role": "user", "content": news_item})
    return chat_text(messages)

def create_podcast(news):
    if news == "":
        raise Exception("news must not be empty")
    messages = [
        {"role": "system", "content": SYSTEMP_PROMPT_WRITER},
        {"role": "user", "content": news},
    ]
    return chat_text(messages)

def rewrite_podcast(input_text):
    if input_text == "":
        raise Exception("input must not be empty")

    messages = [
        {"role": "system", "content": SYSTEMP_PROMPT_REWRITER_2},
        {"role": "user", "content": input_text},
    ]

    return chat_text(messages)

def create_transition(script1, script2):
    if script1 == "" or script2 == "" or script1 == script2:
        raise Exception("transition script must not be empty")

    messages = [
        {"role": "system", "content": SYSTEMP_PROMPT_TRANSITION},
        {"role": "user", "content": f"Create a transition between these two news stories:\n\nSTORY 1:\n{script1}\n\nSTORY 2:\n{script2}"}
    ]

    return chat_text(messages)

def create_weather_forecast(weather):
    if weather == "":
        raise Exception("weather script must not be empty")

    messages = [
        {"role": "system", "content": SYSTEMP_PROMPT_WEATHER},
        {"role": "user", "content": weather},
    ]

    return chat_text(messages)

    
def create_news_title(news):
    if news == "":
        raise Exception("news must not be empty")
    messages = [
        {"role": "system", "content": SYSTEMP_PROMPT_NEWS_TITLE},
        {"role": "user", "content": news},
    ]
    return chat_text(messages)