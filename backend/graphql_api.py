from typing import List, Optional
from crawler.news_crawler import news_crawler
import strawberry
from flask import Request
from datetime import datetime
import asyncio
import time
import threading
from podcast import store_transition_audio, create_news_summary_podcast, generate_id, create_news_summary_podcast, create_podcast
from db.db import get_podcast, get_podcast_embedding, get_user_preference_vector, get_hot_podcasts, get_trending_podcasts, get_podcasts, search_podcast_by_dense, search_podcast_hybrid, get_history, update_user_listen_position, get_user_podcast_rate, update_user_location
from db.db import create_playlist, rename_playlist, delete_playlist, add_to_playlist, delete_from_playlist, get_playlist_items, get_user_playlists
from db.files import *
from db.cache import store
from crawler.rss import show_rss_links, add_rss_link, delete_rss_link, update_rss_link, get_link_status, check_available_rss_link
from daily import generate_daily_podcast
from user_activity import user_activity_log, search
from cuda_stuff import embedding_model
from dotenv import load_dotenv, set_key, dotenv_values

load_dotenv()


@strawberry.type
class Podcast:
    id: str
    title: str
    link: str
    published_at: str
    fetched_at: str
    content_url: str
    image_url: str
    audio_url: str
    transcript_url: str
    duration_seconds: float
    rate: float
@strawberry.type
class Transition:
    image_url: str
    audio_url: str
    transcript_url: str
    secs: float

@strawberry.type
class PodcastCard:
    id: str
    title: str
    image_url: str
    published_at: str
    duration_seconds: float

@strawberry.type
class Playlist:
    playlist_id: str
    name: str
    description: str
    created_at: str

@strawberry.type
class ListeningHistory:
    podcast_id: str
    title: str
    image_url: str
    published_at: str
    duration_seconds: float

@strawberry.type
class PodcastHistory:
    podcast_id: str
    title: str
    image_url: str
    listened_at: str
    duration_seconds: float
    completed: bool
    listen_duration_seconds: float
    stop_position_seconds: float
    play_count: int
    rate: float

@strawberry.type
class ActionDetails:
    from_: Optional[float] = strawberry.field(name="from")
    to: Optional[float]
    playlistId: Optional[str]

@strawberry.type
class UserAction:
    timestamp: int
    action: str
    podcastId: str
    details: Optional[ActionDetails]

@strawberry.type
class PlaylistItem:
    id: str
    title: str
    image_url: str
    added_at: str
    duration_seconds: float

@strawberry.input
class ActionDetailsInput:
    from_: Optional[float] = strawberry.field(name="from", default=None)
    to: Optional[float] = None
    playlistId: Optional[str] = None

@strawberry.input
class UserActionInput:
    timestamp: int
    action: str
    podcastId: str
    details: Optional[ActionDetailsInput] = None

@strawberry.input
class PositionLogInput:
    time: int
    position: float

@strawberry.input
class UserLogInput:
    podcast_id: str
    actions: Optional[List[UserActionInput]] = None
    listened_seconds: List[int]
    listen_duration_seconds: float
    total_duration_seconds: float
    coverage_percentage: float
    last_position: float
    position_log: List[PositionLogInput]
    listening_time: int
    auto_play: bool

@strawberry.type
class RSSLink:
    id: str
    link: str
    country: str
    category: str
    lastCheck: str
    available: bool

@strawberry.type
class Query:
    @strawberry.field
    def rss_links(self) -> List[RSSLink]:
        res = []
        for link in show_rss_links():
            res.append(RSSLink(
                id=link["id"],
                link=link["link"],
                country=link["country"],
                category=link["category"],
                lastCheck=link["lastCheck"],
                available=link["available"],
            ))
        return res
    
    @strawberry.field
    def rss_link(self, id: int) -> RSSLink:
        link = get_link_status(id)
        if link:
            return RSSLink(
                id=link["id"],
                link=link["link"],
                country=link["country"],
                category=link["category"],
                lastCheck=link["lastCheck"],
                available=link["available"],
            )
        else:
            raise ValueError("RSS link not found")
        
    @strawberry.field
    def find_podcast(self, info, id: str) -> Podcast:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        podcast = get_podcast(id)
        rate = get_user_podcast_rate(user_id, id)
        if podcast is None:
            return Podcast(
                id=id,
                title="Podcast Summary",
                link="",
                published_at="",
                fetched_at="",
                content_url="",
                image_url="",
                audio_url="",
                transcript_url="",
                duration_seconds=0,
                rate=rate,
            )
        def load_content_task():
            asyncio.run(create_podcast(podcast["id"]))
        threading.Thread(target=load_content_task).start()
        return Podcast(
            id=podcast["id"],
            title=podcast["title"],
            link=podcast["link"],
            published_at=podcast["published_at"],
            fetched_at=podcast["fetched_at"],
            content_url=podcast["content_url"],
            image_url=podcast["image_url"] if podcast["image_url"] else "image/default.png",
            audio_url=podcast["audio_url"],
            transcript_url=podcast["transcript_url"],
            duration_seconds=podcast["duration_seconds"],
            rate=rate,
        )


    @strawberry.field
    def generate(self, info, location: Optional[str] = None, force: bool = False, summary: bool = False) -> Podcast:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        if location is not None and location != [0, 0]:
            update_user_location(user_id, location)
        podcast = generate_daily_podcast(user_id, force=force, location=location, summary=summary)
        return Podcast(
            id=podcast["id"],
            title=podcast["title"],
            link=podcast["link"],
            published_at=podcast["published_at"],
            fetched_at=podcast["fetched_at"],
            content_url=podcast["content_url"],
            image_url=podcast["image_url"],
            audio_url=podcast["audio_url"],
            transcript_url=podcast["transcript_url"],
            duration_seconds=podcast["duration_seconds"],
            rate=0,
        )

    @strawberry.field
    def transition(self, id1: str, id2: str) -> Transition:
        if not id1 or not id2:
            raise ValueError("id1 and id2 are required")
        if id1 == id2:
            raise ValueError("id1 and id2 cannot be the same")
        if store.exists(f"{id1}:{id2}"):
            transition_files = store.get(f"{id1}:{id2}")
            if isinstance(transition_files, dict):
                return Transition(
                    image_url="image/host.png",
                    audio_url=transition_files["audio_url"],
                    transcript_url=transition_files["transcript_url"],
                    secs=transition_files["duration"],
                )
            else:
                raise ValueError("Transition files not found")
        def load_transition_task():
            asyncio.run(store_transition_audio(id1, id2))
        threading.Thread(target=load_transition_task).start()
        return Transition(
            image_url="image/host.png",
            audio_url="",
            transcript_url="",
            secs=0,
        )

    @strawberry.field
    def summary(self, info, pids: List[str]) -> Podcast:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        if not pids:
            raise ValueError("pids are required")
        pid = generate_id(pids)
        podcast = get_podcast(pid)
        if podcast:
            return Podcast(
                id=podcast["id"],
                title=podcast["title"],
                link=podcast["link"],
                published_at=podcast["published_at"],
                fetched_at=podcast["fetched_at"],
                content_url=podcast["content_url"],
                image_url="image/default.png",
                audio_url=podcast["audio_url"],
                transcript_url=podcast["transcript_url"],
                duration_seconds=podcast["duration_seconds"],
                rate=0,
            )
        def load_summary_task():
            asyncio.run(create_news_summary_podcast(user_id, pids))
        threading.Thread(target=load_summary_task).start()
        return Podcast(
            id=pid,
            title="Summary",
            link="summary",
            published_at=datetime.now(),
            fetched_at=datetime.now(),
            content_url="",
            image_url="image/summary.png",
            audio_url="",
            transcript_url="",
            duration_seconds=0,
            rate=0,
        )
    
    @strawberry.field
    def history(self, info) -> List[PodcastHistory]:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        history = get_history(user_id)
        return [PodcastHistory(
            podcast_id=item["id"],
            title=item["title"],
            image_url=item["image_url"],
            listened_at=item["listened_at"],
            duration_seconds=item["duration_seconds"],
            completed=item["completed"],
            listen_duration_seconds=item["listen_duration_seconds"],
            stop_position_seconds=item["stop_position_seconds"],
            play_count=item["play_count"],  
            rate=item["rate"],
        ) for item in history]
    
    @strawberry.field
    def search(self, info, query: str) -> List[Podcast]:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        with embedding_model():
            pids = search_podcast_hybrid(query)
            podcasts = get_podcasts(pids)
            search(user_id, query)
            return [PodcastCard(    
                id=item["id"],
                title=item["title"],
                image_url=item["image_url"] if item["image_url"] else "image/default.png",
                published_at=item["published_at"],
                duration_seconds=item["duration_seconds"],
            ) for item in podcasts]
        
    @strawberry.field
    def recommendations(self, info, podcast_id: str = None) -> List[Podcast]:
        request: Request = info.context["request"]
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
            return []
        history = get_history(user_id, include_hidden=True)
        history = [item["id"] for item in history]
        pids = search_podcast_by_dense(preference_vector, limit=100, history=history, time_range=time.time() - 60 * 60 * 24 * 7)
        podcasts = get_podcasts(pids)
        pids = asyncio.run(news_crawler(podcasts, find=20))
        podcasts = [podcast for podcast in podcasts if podcast["id"] in pids]
        return [PodcastCard(
            id=item["id"],
            title=item["title"],
            image_url=item["image_url"] if item["image_url"] else "image/default.png",
            published_at=item["published_at"],
            duration_seconds=item["duration_seconds"],
        ) for item in podcasts]
    
    @strawberry.field
    def trending(self, info) -> List[Podcast]:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        non_duplicate_podcasts = []
        pids = set()
        preference = get_user_preference_vector(user_id)
        all_list = get_hot_podcasts(limit=5)
        all_list.extend(get_trending_podcasts(preference, limit=5))
        for podcast in all_list:
            if podcast["id"] not in pids:
                non_duplicate_podcasts.append(podcast)
                pids.add(podcast["id"])
        return [PodcastCard(
            id=item["id"],
            title=item["title"],
            image_url=item["image_url"] if item["image_url"] else "image/default.png",
            published_at=item["published_at"],
            duration_seconds=item["duration"],
        ) for item in non_duplicate_podcasts]
    
    @strawberry.field   
    def playlists(self, info) -> List[Playlist]:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        playlists = get_user_playlists(user_id)
        return [Playlist(
            playlist_id=item["playlist_id"],
            name=item["name"],
            description=item["description"],
            created_at=item["created_at"],
        ) for item in playlists]
    
    @strawberry.field
    def playlist(self, playlist_id: str) -> List[PlaylistItem]:
        items = get_playlist_items(playlist_id)
        return [PlaylistItem(
            id=item["podcast_id"],
            title=item["title"],
            image_url=item["image_url"] if item["image_url"] else "image/default.png",
            added_at=item["added_at"],
            duration_seconds=item["duration_seconds"],
        ) for item in items]
    
@strawberry.type
class Mutation:
    
    @strawberry.mutation
    def add_link(self, link: str, country: str, category: str) -> str:
        add_rss_link(link, country, category)
        return "success"
    
    @strawberry.mutation
    def delete_link(self, id: int) -> str:
        delete_rss_link(id)
        return "success"
    
    @strawberry.mutation
    def update_link(self, id: int, link: str, country: str, category: str) -> str:
        update_rss_link(id, link, country, category)
        return "success"
    
    @strawberry.mutation
    def check_link(self, id: int) -> str:
        check_available_rss_link(id)
        return "success"
    
    @strawberry.mutation
    def new_playlist(self, info, name: str, description: str) -> str:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        playlist_id = create_playlist(user_id, name, description)
        return playlist_id
    
    @strawberry.mutation
    def update_playlist(self, info, playlist_id: str, name: str, description: str) -> str:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        rename_playlist(user_id, playlist_id, name, description)
        return playlist_id
    
    @strawberry.mutation
    def remove_playlist(self, info, playlist_id: str) -> str:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        delete_playlist(user_id, playlist_id)
        return playlist_id
    
    @strawberry.mutation
    def add_to_playlist(self, playlist_id: str, podcast_id: str) -> str:
        add_to_playlist(playlist_id, podcast_id)
        return playlist_id
    
    @strawberry.mutation
    def remove_from_playlist(self, playlist_id: str, podcast_id: str) -> str:
        delete_from_playlist(playlist_id, podcast_id)
        return playlist_id
    
    @strawberry.mutation
    def playing(self, info, podcast_id: str, position: int) -> str:
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        update_user_listen_position(user_id, podcast_id, position)
        return podcast_id
    
    @strawberry.mutation
    def mark_as_played(self, info, actions: UserLogInput) -> str:
        # Convert UserLogInput object to dictionary format expected by user_activity_log
        request: Request = info.context["request"]
        user_id = request.environ.get("USER_ID")
        actions_dict = {
            'podcast_id': actions.podcast_id,
            'actions': [
                {
                    'timestamp': action.timestamp,
                    'action': action.action,
                    'podcastId': action.podcastId,
                    'details': {
                        'from': action.details.from_ if action.details else None,
                        'to': action.details.to if action.details else None,
                        'playlistId': action.details.playlistId if action.details else None
                    } if action.details else None
                } for action in (actions.actions or [])
            ],
            'listened_seconds': actions.listened_seconds,
            'listen_duration_seconds': actions.listen_duration_seconds,
            'total_duration_seconds': actions.total_duration_seconds,
            'coverage_percentage': actions.coverage_percentage,
            'last_position': actions.last_position,
            'position_log': [
                {
                    'time': pos.time,
                    'position': pos.position
                } for pos in actions.position_log
            ],
            'listening_time': actions.listening_time,
            'auto_play': actions.auto_play
        }
        user_activity_log(user_id, actions_dict)
        return "success"

schema = strawberry.federation.Schema(query=Query, mutation=Mutation)