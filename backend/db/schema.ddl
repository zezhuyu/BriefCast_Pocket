CREATE TABLE clusters (
    cid TEXT PRIMARY KEY,
    trending BOOLEAN DEFAULT FALSE,
    trending_time TIMESTAMP,
    trending_score INTEGER DEFAULT 0,
    hot BOOLEAN DEFAULT FALSE,
    hot_time TIMESTAMP,
    hot_score INTEGER DEFAULT 0
);

CREATE TABLE podcasts (
    id TEXT PRIMARY KEY,
    daily TEXT,
    link TEXT UNIQUE,
    cluster_id TEXT REFERENCES clusters(cid) ON DELETE SET NULL,
    title TEXT UNIQUE,
    published_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fetched_at TIMESTAMP,
    content_url TEXT,
    script_url TEXT,
    audio_url TEXT,
    transcript_url TEXT,
    cover_image_url TEXT,
    duration_seconds INTEGER
);

CREATE TABLE user_podcast_history (
    user_id TEXT NOT NULL,
    podcast_id TEXT REFERENCES podcasts(id) ON DELETE CASCADE,
    listened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    hidden BOOLEAN DEFAULT false,
    listen_duration_seconds INTEGER DEFAULT 0,
    stop_position_seconds INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT false,
    play_count INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    add_to_playlist INTEGER DEFAULT 0,
    rate INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, podcast_id, listened_at)
);

CREATE TABLE user_podcast_playlists (
    user_id TEXT NOT NULL,
    playlist_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE podcast_playlist_items (
    playlist_id TEXT REFERENCES user_podcast_playlists(playlist_id) ON DELETE CASCADE,
    podcast_id TEXT REFERENCES podcasts(id) ON DELETE SET NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (playlist_id, podcast_id)
);

CREATE INDEX idx_podcasts_cluster_id ON podcasts(cluster_id);
CREATE INDEX idx_podcasts_trending_time ON clusters(trending_time);
CREATE INDEX idx_podcasts_hot_time ON clusters(hot_time);
CREATE INDEX idx_podcasts_published_at ON podcasts(published_at);
CREATE INDEX idx_podcasts_created_at ON podcasts(fetched_at);
CREATE INDEX idx_user_podcast_history_podcast_id ON user_podcast_history(podcast_id);
CREATE INDEX idx_user_podcast_history_listened_at ON user_podcast_history(listened_at);
CREATE INDEX idx_podcast_playlist_items_playlist_id ON podcast_playlist_items(playlist_id);