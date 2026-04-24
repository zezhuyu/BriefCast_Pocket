import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  ListenHistoryItem,
  Podcast,
  PlaylistInfo,
  RecommendationPodcast,
  SearchResult,
  UserProfile
} from "../shared/types";

// ── Bridge helper ─────────────────────────────────────────────────────────────
const bc = () => window.briefcast!;

// ── Resource dir context (for default image fallback) ─────────────────────────
const ResourceDirCtx = createContext("");
function useDefaultImg(): string {
  const dir = useContext(ResourceDirCtx);
  return dir ? `file://${dir}/default.png` : "";
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Page = "player" | "library" | "history" | "downloads" | "settings";

interface LrcLine { at: number; text: string }

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseLrc(raw: string): LrcLine[] {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/);
      if (!m) return null;
      const at = Number(m[1]) * 60 + Number(m[2]) + Number(`0.${(m[3] ?? "0").padEnd(3, "0")}`);
      return { at, text: (m[4] ?? "").trim() || "…" };
    })
    .filter((x): x is LrcLine => x !== null)
    .sort((a, b) => a.at - b.at);
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

function toRelDate(ts: number): string {
  if (!ts) return "";
  const ms = typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts;
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

function fmtDuration(s: number): string {
  if (!s || s <= 0) return "";
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function recToPodcast(rec: RecommendationPodcast): Podcast {
  return {
    id: rec.id,
    title: rec.title,
    subcategory: rec.subcategory,
    source_name: rec.sourceName,
    image_url: rec.imageUrl ?? "",
    audio_url: "",
    transcript_url: "",
    duration_seconds: rec.estimatedDurationSeconds,
    published_at: rec.publishedAt,
    link: rec.url,
  };
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function NavBar({ page, setPage }: {
  page: Page;
  setPage: (p: Page) => void;
}) {
  return (
    <header className="bc-nav">
      <div className="bc-nav-inner">
        <button className="bc-logo" onClick={() => setPage("player")}>BriefCast</button>
        <nav className="bc-nav-links">
          <button className={page === "player" ? "active" : ""} onClick={() => setPage("player")}>Player</button>
          <button className={page === "library" ? "active" : ""} onClick={() => setPage("library")}>Library</button>
          <button className={page === "downloads" ? "active" : ""} onClick={() => setPage("downloads")}>Downloads</button>
          <button className={page === "history" ? "active" : ""} onClick={() => setPage("history")}>History</button>
          <button className={"bc-icon-btn" + (page === "settings" ? " active" : "")} onClick={() => setPage("settings")} title="Settings">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </nav>
      </div>
    </header>
  );
}

// ── Mini Player ───────────────────────────────────────────────────────────────
function MiniPlayer({ podcast, isPlaying, currentTime, duration, onToggle, onSeek, onNavigate }: {
  podcast: Podcast | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onToggle: () => void;
  onSeek: (t: number) => void;
  onNavigate: () => void;
}) {
  const defaultImg = useDefaultImg();
  if (!podcast) return null;
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="bc-mini-player" onClick={onNavigate}>
      <div className="bc-mini-player-inner">
        <img src={podcast.image_url || defaultImg} alt="" className="bc-mini-img" onError={(e) => { (e.target as HTMLImageElement).src = defaultImg; }} />
        <div className="bc-mini-info">
          <p className="bc-mini-title">{podcast.title}</p>
          <p className="bc-mini-sub">{podcast.subcategory}</p>
        </div>
        <button
          className="bc-mini-play"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
        >
          {isPlaying
            ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6" /></svg>
            : <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          }
        </button>
        <span className="bc-mini-time">{fmtTime(currentTime)}</span>
      </div>
      <div className="bc-mini-progress">
        <div className="bc-mini-bar" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Playlist Modal ────────────────────────────────────────────────────────────
function PlaylistModal({ podcast, playlists, onClose, onAdd, onCreateAndAdd }: {
  podcast: Podcast;
  playlists: PlaylistInfo[];
  onClose: () => void;
  onAdd: (playlistId: string) => void;
  onCreateAndAdd: (name: string) => void;
}) {
  const [newName, setNewName] = useState("");
  return (
    <div className="bc-modal-backdrop" onClick={onClose}>
      <div className="bc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bc-modal-header">
          <h3>Add to Playlist</h3>
          <button onClick={onClose}>✕</button>
        </div>
        <p className="bc-modal-sub">{podcast.title}</p>
        <div className="bc-modal-list">
          {playlists.map((pl) => (
            <button key={pl.id} className="bc-playlist-item" onClick={() => { onAdd(pl.id); onClose(); }}>
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
              </svg>
              {pl.name}
            </button>
          ))}
        </div>
        <div className="bc-modal-create">
          <input
            placeholder="New playlist name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { onCreateAndAdd(newName.trim()); onClose(); } }}
          />
          <button onClick={() => { if (newName.trim()) { onCreateAndAdd(newName.trim()); onClose(); } }}>Create</button>
        </div>
      </div>
    </div>
  );
}

// ── Player Page ───────────────────────────────────────────────────────────────
function PlayerPage({
  podcast, setPodcast, isPlaying, currentTime, duration, lrcLines,
  audioRef, onToggle, onSeek, playlists, onAddToPlaylist, onCreatePlaylist, onRate,
  isGenerating, onGenerateDaily, onForceDaily, queue, onPrev, onNext, onPlayQueueItem,
}: {
  podcast: Podcast | null;
  setPodcast: (p: Podcast) => void;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  lrcLines: LrcLine[];
  audioRef: React.RefObject<HTMLAudioElement | null>;
  onToggle: () => void;
  onSeek: (t: number) => void;
  playlists: PlaylistInfo[];
  onAddToPlaylist: (playlistId: string, podcast: Podcast) => void;
  onCreatePlaylist: (name: string) => Promise<PlaylistInfo>;
  onRate: (podcastId: string, rating: number) => void;
  isGenerating: boolean;
  onGenerateDaily: () => void;
  onForceDaily: () => void;
  queue: RecommendationPodcast[];
  onPrev: () => void;
  onNext: () => void;
  onPlayQueueItem: (rec: RecommendationPodcast) => void;
}) {
  const defaultImg = useDefaultImg();
  const [colors, setColors] = useState({ primary: "rgb(100,34,254)", secondary: "rgb(36,63,254)", tertiary: "rgb(79,70,229)" });
  const [hoverPos, setHoverPos] = useState(-1);
  const [isLiked, setIsLiked] = useState(false);
  const [isDisliked, setIsDisliked] = useState(false);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [userScrolling, setUserScrolling] = useState(false);
  const [mobileView, setMobileView] = useState<"player" | "transcript">("player");
  const [rightTab, setRightTab] = useState<"transcript" | "playlist">("transcript");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waveform = useMemo(() => Array.from({ length: 100 }, () => Math.random() * 100), []);
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Extract colors from cover image
  useEffect(() => {
    if (!podcast?.image_url) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = podcast.image_url;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width || 1;
      canvas.height = img.height || 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      try {
        const c = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
        const br = ctx.getImageData(img.width - 1, img.height - 1, 1, 1).data;
        const tl = ctx.getImageData(0, 0, 1, 1).data;
        setColors({
          primary: `rgb(${c[0]},${c[1]},${c[2]})`,
          secondary: `rgb(${br[0]},${br[1]},${br[2]})`,
          tertiary: `rgb(${tl[0]},${tl[1]},${tl[2]})`,
        });
      } catch {}
    };
  }, [podcast?.image_url]);

  // Auto-scroll transcript
  useEffect(() => {
    if (!transcriptRef.current || userScrolling || !lrcLines.length) return;
    const idx = findLastIndex(lrcLines, (l) => l.at <= currentTime);
    if (idx < 0) return;
    const paras = transcriptRef.current.querySelectorAll("p");
    const el = paras[idx];
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentTime, lrcLines, userScrolling]);

  const handleTranscriptScroll = useCallback(() => {
    setUserScrolling(true);
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => setUserScrolling(false), 2500);
  }, []);

  const handleWaveformClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  };

  if (!podcast) {
    return (
      <div className="bc-player-empty">
        <div className="bc-player-empty-inner">
          {isGenerating
            ? <>
                <div className="bc-spinner" />
                <p className="bc-loading-text">Generating your daily briefing…</p>
                <p className="bc-loading-sub">This may take a few minutes the first time.</p>
              </>
            : <>
                <div className="bc-empty-icon">🎙️</div>
                <h2>Your daily briefing is ready</h2>
                <p>Click below to generate today's podcast</p>
                <button className="bc-btn-primary" onClick={onGenerateDaily}>Generate Daily Podcast</button>
              </>
          }
        </div>
      </div>
    );
  }

  const activeIdx = findLastIndex(lrcLines, (l) => l.at <= currentTime);

  return (
    <div className="bc-player-root">
      {/* Animated background */}
      <div className="bc-bg" style={{ background: `linear-gradient(145deg, ${colors.primary}, ${colors.secondary})`, opacity: 0.8 }} />
      <div className="bc-blobs">
        <div className="bc-blob bc-blob-1" style={{ background: `radial-gradient(circle, ${colors.primary}, transparent 70%)` }} />
        <div className="bc-blob bc-blob-2" style={{ background: `radial-gradient(circle, ${colors.secondary}, transparent 70%)` }} />
        <div className="bc-blob bc-blob-3" style={{ background: `radial-gradient(circle, ${colors.tertiary}, transparent 70%)` }} />
      </div>

      <div className="bc-player-content">
        <div className="bc-player-card">
          <div className="bc-player-grid">
            {/* Left: player controls */}
            {(mobileView === "player") && (
              <div className="bc-player-left">
                {/* Cover art */}
                <div className="bc-cover-wrap">
                  <img
                    src={podcast.image_url || defaultImg}
                    alt={podcast.title}
                    className="bc-cover-img"
                    onError={(e) => { (e.target as HTMLImageElement).src = defaultImg; }}
                  />
                  <div className="bc-cover-overlay">
                    <h2 className="bc-cover-title">{podcast.title}</h2>
                    {podcast.link && (
                      <a href={podcast.link} target="_blank" rel="noopener noreferrer" className="bc-cover-link">
                        <svg className="w-4 h-4 mr-1 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                        View source
                      </a>
                    )}
                    <p className="bc-cover-meta">{toRelDate(podcast.published_at)} · {fmtDuration(podcast.duration_seconds)}</p>
                  </div>
                </div>

                {/* Waveform */}
                <div
                  className="bc-waveform"
                  onClick={handleWaveformClick}
                  onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHoverPos((e.clientX - r.left) / r.width); }}
                  onMouseLeave={() => setHoverPos(-1)}
                >
                  {waveform.map((h, i) => {
                    const pos = i / waveform.length;
                    const played = currentTime > 0 && pos <= pct / 100;
                    const hovered = hoverPos >= 0 && !played && pos > pct / 100 && pos <= hoverPos;
                    return (
                      <div
                        key={i}
                        className="bc-bar"
                        style={{
                          height: `${h}%`,
                          background: played
                            ? "linear-gradient(to bottom, #d4af37, #996521)"
                            : hovered ? "rgb(120,120,120)" : "rgba(220,220,220,0.7)"
                        }}
                      />
                    );
                  })}
                </div>
                <div className="bc-time-row">
                  <span>{fmtTime(currentTime)}</span>
                  <span>{fmtTime(duration)}</span>
                </div>

                {/* Controls */}
                <div className="bc-controls">
                  {/* Dislike */}
                  <button
                    className={`bc-ctrl-btn ${isDisliked ? "active-red" : ""}`}
                    onClick={() => { const nd = !isDisliked; setIsDisliked(nd); if (nd) setIsLiked(false); onRate(podcast.id, nd ? -1 : 0); }}
                    title="Dislike"
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
                    </svg>
                  </button>

                  {/* Prev track */}
                  <button className="bc-ctrl-btn" onClick={onPrev} title="Previous">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                    </svg>
                  </button>

                  {/* Play / Pause */}
                  <button className="bc-play-btn" onClick={onToggle}>
                    {isPlaying
                      ? <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      : <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    }
                  </button>

                  {/* Next track */}
                  <button className="bc-ctrl-btn" onClick={onNext} title="Next">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                    </svg>
                  </button>

                  {/* Like */}
                  <button
                    className={`bc-ctrl-btn ${isLiked ? "active-green" : ""}`}
                    onClick={() => { const nl = !isLiked; setIsLiked(nl); if (nl) setIsDisliked(false); onRate(podcast.id, nl ? 1 : 0); }}
                    title="Like"
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                    </svg>
                  </button>

                  {/* Add to playlist */}
                  <button className="bc-ctrl-btn" onClick={() => setShowPlaylistModal(true)} title="Add to playlist">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                  </button>

                  {/* Regenerate (daily only) */}
                  {podcast.is_daily && (
                    <button className="bc-ctrl-btn" onClick={onForceDaily} title="Regenerate daily briefing" disabled={isGenerating}>
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Mobile transcript toggle */}
                <div className="bc-mobile-tab-row md:hidden">
                  <button onClick={() => setMobileView("transcript")}>
                    📄 Transcript
                  </button>
                </div>
              </div>
            )}

            {/* Right: transcript + up next tabs */}
            <div className={`bc-transcript-panel${mobileView !== "transcript" ? " hidden-mobile" : ""}`}>
              <div className="bc-transcript-header">
                {/* Tab switcher */}
                <div style={{ display: "flex", gap: "4px" }}>
                  <button
                    className={`bc-tab-btn${rightTab === "transcript" ? " active" : ""}`}
                    onClick={() => setRightTab("transcript")}
                  >
                    Transcript
                  </button>
                  <button
                    className={`bc-tab-btn${rightTab === "playlist" ? " active" : ""}`}
                    onClick={() => setRightTab("playlist")}
                  >
                    Up Next
                  </button>
                </div>
                {mobileView === "transcript" && (
                  <button onClick={() => setMobileView("player")}>✕</button>
                )}
              </div>

              {/* Transcript tab */}
              {rightTab === "transcript" && (
                lrcLines.length === 0
                  ? <p className="bc-transcript-empty">Transcript loading…</p>
                  : (
                    <div className="bc-transcript-scroll" ref={transcriptRef} onScroll={handleTranscriptScroll}>
                      {lrcLines.map((line, i) => (
                        <p
                          key={i}
                          className={`bc-transcript-line ${i === activeIdx ? "active" : ""}`}
                          onClick={() => { onSeek(line.at); setUserScrolling(false); }}
                        >
                          <span className="bc-transcript-ts">{fmtTime(line.at)}</span>
                          {line.text}
                        </p>
                      ))}
                    </div>
                  )
              )}

              {/* Up Next tab */}
              {rightTab === "playlist" && (
                <div className="bc-transcript-scroll">
                  {queue.length === 0
                    ? <p className="bc-transcript-empty">No upcoming episodes.</p>
                    : queue
                        .filter((r) => r.id !== podcast?.id)
                        .map((rec) => (
                          <div
                            key={rec.id}
                            className="bc-queue-item"
                            onClick={() => onPlayQueueItem(rec)}
                          >
                            <img
                              src={rec.imageUrl ?? ""}
                              alt={rec.title}
                              className="bc-queue-img"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                            />
                            <div className="bc-queue-info">
                              <p className="bc-queue-title">{rec.title}</p>
                              <p className="bc-queue-sub">{rec.sourceName} · {toRelDate(rec.publishedAt)}</p>
                            </div>
                          </div>
                        ))
                  }
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showPlaylistModal && (
        <PlaylistModal
          podcast={podcast}
          playlists={playlists}
          onClose={() => setShowPlaylistModal(false)}
          onAdd={(pid) => onAddToPlaylist(pid, podcast)}
          onCreateAndAdd={async (name) => {
            const pl = await onCreatePlaylist(name);
            onAddToPlaylist(pl.id, podcast);
          }}
        />
      )}
    </div>
  );
}

// ── Podcast Card ──────────────────────────────────────────────────────────────
function PodcastCard({ podcast, isInSummary, onPlay, onSummaryToggle, onAddToPlaylist }: {
  podcast: RecommendationPodcast;
  isInSummary: boolean;
  onPlay: () => void;
  onSummaryToggle: () => void;
  onAddToPlaylist: () => void;
}) {
  const defaultImg = useDefaultImg();
  const imageUrl = podcast.imageUrl || defaultImg;
  return (
    <div className="bc-card" onClick={onPlay}>
      <div className="bc-card-img-wrap">
        <img src={imageUrl} alt={podcast.title} className="bc-card-img" onError={(e) => { (e.target as HTMLImageElement).src = defaultImg; }} />
        <button className={`bc-card-summary-btn ${isInSummary ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); onSummaryToggle(); }} title={isInSummary ? "Remove from summary" : "Add to summary"}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </button>
        <button className="bc-card-playlist-btn" onClick={(e) => { e.stopPropagation(); onAddToPlaylist(); }}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
        </button>
      </div>
      <div className="bc-card-info">
        <h3 className="bc-card-title">{podcast.title}</h3>
        <p className="bc-card-sub">{podcast.subcategory}</p>
        <p className="bc-card-date">{toRelDate(podcast.publishedAt)}</p>
      </div>
    </div>
  );
}

// ── Library Page ──────────────────────────────────────────────────────────────
function LibraryPage({ onPlay, playlists, onAddToPlaylist, onCreatePlaylist }: {
  onPlay: (podcast: RecommendationPodcast) => void;
  playlists: PlaylistInfo[];
  onAddToPlaylist: (playlistId: string, podcast: Podcast) => void;
  onCreatePlaylist: (name: string) => Promise<PlaylistInfo>;
}) {
  const [recs, setRecs] = useState<RecommendationPodcast[]>([]);
  const [trending, setTrending] = useState<RecommendationPodcast[]>([]);
  const [history, setHistory] = useState<ListenHistoryItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [summaryList, setSummaryList] = useState<string[]>([]);
  const [isCreatingSummary, setIsCreatingSummary] = useState(false);
  const [summaryPodcast, setSummaryPodcast] = useState<Podcast | null>(null);
  const [playlistTarget, setPlaylistTarget] = useState<RecommendationPodcast | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [r, t, h] = await Promise.all([
          bc().getRecommendations(40),
          bc().getTrending(20),
          bc().getHistory(20),
        ]);
        setRecs(r);
        setTrending(t);
        setHistory(h);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleSearch = async () => {
    if (!searchTerm.trim()) return;
    const results = await bc().searchArticles(searchTerm, "hybrid", 20);
    setSearchResults(results);
  };

  const toggleSummary = (id: string) => {
    setSummaryList((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 10 ? [...prev, id] : prev
    );
  };

  const createSummary = async () => {
    if (!summaryList.length) return;
    setIsCreatingSummary(true);
    try {
      const podcast = await bc().generateSummaryPodcast(summaryList);
      setSummaryPodcast(podcast);
      setSummaryList([]);
      onPlay(recToPodcast(podcast as any) as any);
    } catch (e) {
      alert(`Failed to create summary: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsCreatingSummary(false);
    }
  };

  const defaultImg = useDefaultImg();

  function recToPodcastLocal(rec: RecommendationPodcast): Podcast {
    return recToPodcast(rec);
  }

  const displayRecs = searchResults.length
    ? searchResults.map((r) => ({ ...r, estimatedDurationSeconds: 180, imageResource: "", subcategory: r.sourceName } as RecommendationPodcast))
    : recs;

  return (
    <div className="bc-library">
      {/* Header */}
      <div className="bc-library-header">
        <h1>Library</h1>
      </div>

      {/* Search */}
      <div className="bc-search-row">
        <div className="bc-search-wrap">
          <svg className="bc-search-icon w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            className="bc-search-input"
            placeholder="Search podcasts…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          {searchTerm && (
            <button className="bc-search-clear" onClick={() => { setSearchTerm(""); setSearchResults([]); }}>✕</button>
          )}
        </div>
        <button className="bc-btn-search" onClick={handleSearch}>Search</button>
      </div>

      {/* Summary panel */}
      {summaryList.length > 0 && (
        <div className="bc-summary-bar">
          <span>{summaryList.length} podcast{summaryList.length !== 1 ? "s" : ""} selected</span>
          <button className="bc-btn-primary" onClick={createSummary} disabled={isCreatingSummary}>
            {isCreatingSummary ? "Generating…" : "Generate Summary Podcast"}
          </button>
          <button className="bc-btn-ghost" onClick={() => setSummaryList([])}>Clear</button>
        </div>
      )}

      {loading ? (
        <div className="bc-loading"><div className="bc-spinner" /><p>Loading…</p></div>
      ) : (
        <>
          {/* Recent History */}
          {history.length > 0 && (
            <section className="bc-section">
              <h2 className="bc-section-title">Recently Played</h2>
              <div className="bc-scroll-row">
                {history.map((item) => (
                  <div key={item.id} className="bc-scroll-card" onClick={() => {}}>
                    <div className="bc-scroll-img-wrap">
                      <img src={item.imageUrl || defaultImg} alt={item.title} className="bc-scroll-img" onError={(e) => { (e.target as HTMLImageElement).src = defaultImg; }} />
                      <div className="bc-history-bar">
                        <div className="bc-history-progress" style={{ width: `${item.durationSeconds > 0 ? (item.progressSeconds / item.durationSeconds) * 100 : 0}%` }} />
                      </div>
                    </div>
                    <div className="bc-scroll-info">
                      <p className="bc-scroll-title">{item.title}</p>
                      <p className="bc-scroll-date">{toRelDate(item.listenedAt)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Hot & Trending */}
          {trending.length > 0 && (
            <section className="bc-section">
              <h2 className="bc-section-title">Hot & Trending</h2>
              <div className="bc-scroll-row">
                {trending.map((rec) => (
                  <div key={rec.id} className="bc-scroll-card" onClick={() => onPlay(rec)}>
                    <div className="bc-scroll-img-wrap">
                      <img
                        src={rec.imageUrl || defaultImg}
                        alt={rec.title}
                        className="bc-scroll-img"
                        onError={(e) => { (e.target as HTMLImageElement).src = defaultImg; }}
                      />
                      <button className={`bc-card-summary-btn sm ${summaryList.includes(rec.id) ? "active" : ""}`}
                        onClick={(e) => { e.stopPropagation(); toggleSummary(rec.id); }}>
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      </button>
                    </div>
                    <div className="bc-scroll-info">
                      <p className="bc-scroll-title">{rec.title}</p>
                      <p className="bc-scroll-date">{toRelDate(rec.publishedAt)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Recommendations — For You */}
          <section className="bc-section">
            <div className="bc-section-header">
              <h2>{searchResults.length ? "Search Results" : "For You"}</h2>
              {searchResults.length > 0 && <button className="bc-btn-ghost" onClick={() => { setSearchTerm(""); setSearchResults([]); }}>Clear search</button>}
            </div>
            <div className="bc-card-grid">
              {displayRecs.map((rec) => (
                <PodcastCard
                  key={rec.id}
                  podcast={rec}
                  isInSummary={summaryList.includes(rec.id)}
                  onPlay={() => onPlay(rec)}
                  onSummaryToggle={() => toggleSummary(rec.id)}
                  onAddToPlaylist={() => setPlaylistTarget(rec)}
                />
              ))}
              {displayRecs.length === 0 && <p className="bc-empty">No results found.</p>}
            </div>
          </section>
        </>
      )}

      {playlistTarget && (
        <PlaylistModal
          podcast={recToPodcastLocal(playlistTarget)}
          playlists={playlists}
          onClose={() => setPlaylistTarget(null)}
          onAdd={(pid) => onAddToPlaylist(pid, recToPodcastLocal(playlistTarget))}
          onCreateAndAdd={async (name) => {
            const pl = await onCreatePlaylist(name);
            onAddToPlaylist(pl.id, recToPodcastLocal(playlistTarget));
          }}
        />
      )}
    </div>
  );
}

// ── History Page ──────────────────────────────────────────────────────────────
function HistoryPage() {
  const defaultImg = useDefaultImg();
  const [history, setHistory] = useState<ListenHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    bc().getHistory(100).then(setHistory).finally(() => setLoading(false));
  }, []);

  return (
    <div className="bc-page">
      <h1 className="bc-page-title">Listening History</h1>
      {loading ? <div className="bc-loading"><div className="bc-spinner" /></div> : (
        <div className="bc-history-list">
          {history.length === 0 ? <p className="bc-empty">No history yet.</p> : history.map((item) => (
            <div key={`${item.id}-${item.listenedAt}`} className="bc-history-item">
              <img src={item.imageUrl || defaultImg} alt="" className="bc-history-img" onError={(e) => { (e.target as HTMLImageElement).src = defaultImg; }} />
              <div className="bc-history-info">
                <p className="bc-history-title">{item.title}</p>
                <p className="bc-history-sub">{item.subcategory} · {item.sourceName}</p>
                <div className="bc-progress-wrap">
                  <div className="bc-progress-bar">
                    <div className="bc-progress-fill" style={{ width: `${item.durationSeconds > 0 ? (item.progressSeconds / item.durationSeconds) * 100 : 0}%` }} />
                  </div>
                  <span className="bc-history-time">{fmtTime(item.progressSeconds)} / {fmtTime(item.durationSeconds)}</span>
                </div>
              </div>
              <span className="bc-history-date">{toRelDate(item.listenedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Downloads Page ────────────────────────────────────────────────────────────
function DownloadsPage({ onPlay }: { onPlay: (podcast: Podcast) => void }) {
  const defaultImg = useDefaultImg();
  const [downloads, setDownloads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    bc().getDownloads(100).then(setDownloads).finally(() => setLoading(false));
  }, []);

  return (
    <div className="bc-page">
      <h1 className="bc-page-title">Downloads</h1>
      {loading ? <div className="bc-loading"><div className="bc-spinner" /></div> : (
        <div className="bc-downloads-list">
          {downloads.length === 0 ? <p className="bc-empty">No downloaded episodes.</p> : downloads.map((d) => (
            <div key={d.id} className="bc-download-item" onClick={() => {}}>
              <img src={d.imageUrl || defaultImg} alt="" className="bc-history-img" onError={(e) => { (e.target as HTMLImageElement).src = defaultImg; }} />
              <div className="bc-history-info">
                <p className="bc-history-title">{d.title}</p>
                <p className="bc-history-sub">{d.subcategory} · {d.sourceName}</p>
                <p className="bc-card-date">Saved {toRelDate(d.savedAt)}</p>
              </div>
              <button className="bc-btn-ghost" onClick={async () => { await bc().removeDownload(d.id); setDownloads((prev) => prev.filter((x) => x.id !== d.id)); }}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Dashboard Page ────────────────────────────────────────────────────────────
// ── Shared input / label / select class helpers ───────────────────────────────
const inputCls = "w-full px-3 py-2 text-sm bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-colors";
const selectCls = "w-full px-3 py-2 text-sm bg-white/10 border border-white/20 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-colors [&>option]:bg-slate-900";
const labelCls = "block text-white/80 text-xs font-medium mb-1";
const fieldCls = "space-y-1";

function SettingsPage() {
  const [tab, setTab] = useState<"preferences" | "server">("preferences");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [rssInput, setRssInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [p, s] = await Promise.all([bc().getUserProfile(), bc().getSettings()]);
        setProfile(p);
        setSettings(s);
      } catch {}
      setLoading(false);
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      if (profile) await bc().updateUserProfile(profile.preference);
      await bc().saveSettings(settings);
      setSaveMsg({ text: "Settings saved!", ok: true });
    } catch {
      setSaveMsg({ text: "Error saving settings.", ok: false });
    }
    setSaving(false);
    setTimeout(() => setSaveMsg(null), 3000);
  };

  const addRss = () => {
    const url = rssInput.trim();
    if (!url) return;
    setSettings((s) => ({ ...s, sources: { ...s.sources, rssFeeds: [...s.sources.rssFeeds, url] } }));
    setRssInput("");
  };

  const removeRss = (url: string) => {
    setSettings((s) => ({ ...s, sources: { ...s.sources, rssFeeds: s.sources.rssFeeds.filter((f) => f !== url) } }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-white/60 text-sm">Loading settings…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Settings</h1>
        <p className="text-white/60 text-sm">Configure your BriefCast experience</p>
      </div>

      {/* Tab bar */}
      <div className="flex mb-6">
        <div className="bg-white/10 backdrop-blur-md rounded-xl p-1 flex gap-1">
          {([
            { key: "preferences", label: "Preferences", icon: "🎯" },
            { key: "server",      label: "Server Config", icon: "⚙️" },
          ] as const).map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm rounded-lg font-medium transition-all duration-200 flex items-center gap-1.5 ${
                tab === key
                  ? "bg-amber-500 text-white shadow-lg"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Preferences tab ─────────────────────────────────────────────────── */}
      {tab === "preferences" && (
        <div className="space-y-4">
          {/* Topics */}
          <div className="bg-white/10 backdrop-blur-md rounded-xl p-5 shadow-xl">
            <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
              <span className="text-lg">🎯</span>
              Topics of Interest
            </h2>
            <div className={fieldCls}>
              <label className={labelCls}>
                Topics <span className="text-white/40 font-normal">(comma-separated)</span>
              </label>
              <input
                className={inputCls}
                value={profile?.preference.topics.join(", ") ?? ""}
                onChange={(e) => setProfile((p) => p ? { ...p, preference: { ...p.preference, topics: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) } } : p)}
                placeholder="technology, business, science, world"
              />
              {/* Topic badges preview */}
              {(profile?.preference.topics ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(profile?.preference.topics ?? []).map((t) => (
                    <span key={t} className="bg-amber-500/20 text-amber-200 px-2 py-0.5 rounded-full text-xs border border-amber-500/30">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Region & Language */}
          <div className="bg-white/10 backdrop-blur-md rounded-xl p-5 shadow-xl">
            <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
              <span className="text-lg">🌍</span>
              Region &amp; Language
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div className={fieldCls}>
                <label className={labelCls}>Region</label>
                <input
                  className={inputCls}
                  value={profile?.preference.region ?? ""}
                  onChange={(e) => setProfile((p) => p ? { ...p, preference: { ...p.preference, region: e.target.value } } : p)}
                  placeholder="US"
                />
              </div>
              <div className={fieldCls}>
                <label className={labelCls}>Language</label>
                <input
                  className={inputCls}
                  value={profile?.preference.language ?? ""}
                  onChange={(e) => setProfile((p) => p ? { ...p, preference: { ...p.preference, language: e.target.value } } : p)}
                  placeholder="en"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Server Config tab ────────────────────────────────────────────────── */}
      {tab === "server" && (
        <div className="space-y-4">
          {/* AI Provider */}
          <div className="bg-white/10 backdrop-blur-md rounded-xl p-5 shadow-xl">
            <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
              <span className="text-lg">🤖</span>
              AI Provider
            </h2>
            <div className="space-y-3">
              <div className={fieldCls}>
                <label className={labelCls}>Active Provider</label>
                <select
                  className={selectCls}
                  value={settings.providers.activeProvider}
                  onChange={(e) => setSettings((s) => ({ ...s, providers: { ...s.providers, activeProvider: e.target.value as AppSettings["providers"]["activeProvider"] } }))}
                >
                  <option value="openai-compatible">OpenAI Compatible</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="codex-cli">Codex CLI</option>
                  <option value="claude-cli">Claude CLI</option>
                </select>
              </div>

              {settings.providers.activeProvider === "openai-compatible" && (
                <div className="grid grid-cols-1 gap-3 pt-1 border-t border-white/10">
                  <div className={fieldCls}>
                    <label className={labelCls}>API Base URL</label>
                    <input className={inputCls} value={settings.providers.openaiCompatible.baseUrl} onChange={(e) => setSettings((s) => ({ ...s, providers: { ...s.providers, openaiCompatible: { ...s.providers.openaiCompatible, baseUrl: e.target.value } } }))} placeholder="https://api.openai.com/v1" />
                  </div>
                  <div className={fieldCls}>
                    <label className={labelCls}>API Key</label>
                    <input className={inputCls} type="password" value={settings.providers.openaiCompatible.apiKey} onChange={(e) => setSettings((s) => ({ ...s, providers: { ...s.providers, openaiCompatible: { ...s.providers.openaiCompatible, apiKey: e.target.value } } }))} placeholder="sk-…" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className={fieldCls}>
                      <label className={labelCls}>Chat Model</label>
                      <input className={inputCls} value={settings.providers.openaiCompatible.model} onChange={(e) => setSettings((s) => ({ ...s, providers: { ...s.providers, openaiCompatible: { ...s.providers.openaiCompatible, model: e.target.value } } }))} placeholder="gpt-4.1-mini" />
                    </div>
                    <div className={fieldCls}>
                      <label className={labelCls}>Embedding Model</label>
                      <input className={inputCls} value={settings.providers.openaiCompatible.embeddingModel} onChange={(e) => setSettings((s) => ({ ...s, providers: { ...s.providers, openaiCompatible: { ...s.providers.openaiCompatible, embeddingModel: e.target.value } } }))} placeholder="text-embedding-3-small" />
                    </div>
                  </div>
                </div>
              )}

              {settings.providers.activeProvider === "anthropic" && (
                <div className="grid grid-cols-1 gap-3 pt-1 border-t border-white/10">
                  <div className={fieldCls}>
                    <label className={labelCls}>API Key</label>
                    <input className={inputCls} type="password" value={settings.providers.anthropic.apiKey} onChange={(e) => setSettings((s) => ({ ...s, providers: { ...s.providers, anthropic: { ...s.providers.anthropic, apiKey: e.target.value } } }))} placeholder="sk-ant-…" />
                  </div>
                  <div className={fieldCls}>
                    <label className={labelCls}>Model</label>
                    <input className={inputCls} value={settings.providers.anthropic.model} onChange={(e) => setSettings((s) => ({ ...s, providers: { ...s.providers, anthropic: { ...s.providers.anthropic, model: e.target.value } } }))} placeholder="claude-3-5-sonnet-latest" />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* TTS */}
          <div className="bg-white/10 backdrop-blur-md rounded-xl p-5 shadow-xl">
            <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
              <span className="text-lg">🔊</span>
              Text-to-Speech
            </h2>
            <div className="space-y-3">
              <div className={fieldCls}>
                <label className={labelCls}>TTS Provider</label>
                <select
                  className={selectCls}
                  value={settings.tts.provider}
                  onChange={(e) => setSettings((s) => ({ ...s, tts: { ...s.tts, provider: e.target.value as AppSettings["tts"]["provider"] } }))}
                >
                  <option value="openai-compatible">OpenAI Compatible</option>
                  <option value="system-say">System Say (macOS)</option>
                </select>
              </div>
              {settings.tts.provider === "openai-compatible" && (
                <div className="grid grid-cols-2 gap-3 pt-1 border-t border-white/10">
                  <div className={fieldCls}>
                    <label className={labelCls}>Voice</label>
                    <input className={inputCls} value={settings.tts.voice} onChange={(e) => setSettings((s) => ({ ...s, tts: { ...s.tts, voice: e.target.value } }))} placeholder="alloy" />
                  </div>
                  <div className={fieldCls}>
                    <label className={labelCls}>TTS Model</label>
                    <input className={inputCls} value={settings.tts.model} onChange={(e) => setSettings((s) => ({ ...s, tts: { ...s.tts, model: e.target.value } }))} placeholder="tts-1" />
                  </div>
                </div>
              )}
              {settings.tts.provider === "system-say" && (
                <div className="pt-1 border-t border-white/10">
                  <div className={fieldCls}>
                    <label className={labelCls}>System Voice</label>
                    <input className={inputCls} value={settings.tts.systemVoice} onChange={(e) => setSettings((s) => ({ ...s, tts: { ...s.tts, systemVoice: e.target.value } }))} placeholder="Samantha" />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* RSS Feeds */}
          <div className="bg-white/10 backdrop-blur-md rounded-xl p-5 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <span className="text-lg">📡</span>
                RSS Feeds
              </h2>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-white/70 text-xs">Enable</span>
                <input
                  type="checkbox"
                  checked={settings.sources.rssEnabled}
                  onChange={(e) => setSettings((s) => ({ ...s, sources: { ...s.sources, rssEnabled: e.target.checked } }))}
                  className="w-4 h-4 accent-amber-500"
                />
              </label>
            </div>

            {/* Feed list */}
            {settings.sources.rssFeeds.length > 0 && (
              <div className="space-y-2 mb-3 max-h-48 overflow-y-auto pr-1">
                {settings.sources.rssFeeds.map((url) => (
                  <div key={url} className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2 group hover:bg-white/10 transition-colors">
                    <span className="flex-1 text-white/80 text-xs truncate font-mono">{url}</span>
                    <button
                      onClick={() => removeRss(url)}
                      className="shrink-0 px-2 py-0.5 text-xs rounded-md bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {settings.sources.rssFeeds.length === 0 && (
              <p className="text-white/40 text-sm mb-3 text-center py-4">No custom RSS feeds added.</p>
            )}

            {/* Add feed input */}
            <div className="flex gap-2">
              <input
                className={inputCls + " flex-1"}
                placeholder="https://example.com/feed.xml"
                value={rssInput}
                onChange={(e) => setRssInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addRss()}
              />
              <button
                onClick={addRss}
                className="shrink-0 px-4 py-2 text-sm font-medium bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save bar */}
      <div className="mt-6 flex items-center justify-between">
        {saveMsg ? (
          <span className={`text-sm font-medium ${saveMsg.ok ? "text-green-400" : "text-red-400"}`}>
            {saveMsg.text}
          </span>
        ) : <span />}
        <button
          onClick={save}
          disabled={saving}
          className="px-6 py-2 text-sm font-semibold bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg shadow-lg transition-colors"
        >
          {saving ? (
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Saving…
            </span>
          ) : "Save Settings"}
        </button>
      </div>
    </div>
  );
}


// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  // Page routing
  const [page, setPage] = useState<Page>("player");

  // Player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentPodcast, setCurrentPodcast] = useState<Podcast | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [lrcLines, setLrcLines] = useState<LrcLine[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // Playlists
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);

  // Queue for Prev/Next navigation
  const [queue, setQueue] = useState<RecommendationPodcast[]>([]);
  const [queueIdx, setQueueIdx] = useState(-1);

  // Resource dir for default image fallback
  const [resourceDir, setResourceDir] = useState("");

  // Load playlists, initial queue, and resource dir on mount
  useEffect(() => {
    bc().getPlaylists().then(setPlaylists).catch(() => {});
    bc().getRecommendations(30).then(setQueue).catch(() => {});
    bc().getMediaManifest().then((m) => setResourceDir(m.resourceDir)).catch(() => {});
  }, []);

  // Load LRC when podcast changes
  useEffect(() => {
    if (!currentPodcast?.transcript_url) { setLrcLines([]); return; }
    fetch(currentPodcast.transcript_url)
      .then((r) => r.text())
      .then((txt) => setLrcLines(parseLrc(txt)))
      .catch(() => setLrcLines([]));
  }, [currentPodcast?.transcript_url]);

  // Wire audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onDuration = () => setDuration(audio.duration || 0);
    const onEnded = () => setIsPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("loadedmetadata", onDuration);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("loadedmetadata", onDuration);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  // Update audio src when podcast changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentPodcast?.audio_url) return;
    audio.src = currentPodcast.audio_url;
    audio.load();
    setCurrentTime(0);
    setDuration(0);
  }, [currentPodcast?.audio_url]);

  const handleToggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  }, [isPlaying]);

  const handleSeek = useCallback((t: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = t;
    setCurrentTime(t);
  }, []);

  const handlePlayPodcast = useCallback(async (rec: RecommendationPodcast) => {
    setPage("player");
    // Track queue position
    setQueueIdx((prev) => {
      const idx = queue.findIndex((r) => r.id === rec.id);
      return idx >= 0 ? idx : prev;
    });
    // Show placeholder immediately
    const placeholder = recToPodcast(rec);
    setCurrentPodcast(placeholder);
    setIsGenerating(true);
    try {
      const podcast = await bc().generatePodcastAudio(rec.id);
      setCurrentPodcast(podcast);
      const audio = audioRef.current;
      if (audio) {
        audio.src = podcast.audio_url;
        audio.load();
        audio.play().then(() => setIsPlaying(true)).catch(() => {});
      }
    } catch (e) {
      console.error("Failed to generate audio:", e);
    }
    setIsGenerating(false);
  }, [queue]);

  const handlePrevTrack = useCallback(() => {
    const prev = queueIdx > 0 ? queue[queueIdx - 1] : null;
    if (prev) handlePlayPodcast(prev);
  }, [queueIdx, queue, handlePlayPodcast]);

  const handleNextTrack = useCallback(() => {
    const next = queueIdx < queue.length - 1 ? queue[queueIdx + 1] : null;
    if (next) handlePlayPodcast(next);
  }, [queueIdx, queue, handlePlayPodcast]);

  const handleGenerateDaily = useCallback(async () => {
    setIsGenerating(true);
    try {
      const podcast = await bc().getDailyPodcast();
      if (podcast) {
        setCurrentPodcast(podcast);
        const audio = audioRef.current;
        if (audio) {
          audio.src = podcast.audio_url;
          audio.load();
          audio.play().then(() => setIsPlaying(true)).catch(() => {});
        }
      }
    } catch (e) {
      console.error("Failed to generate daily podcast:", e);
    }
    setIsGenerating(false);
  }, []);

  const handleForceDaily = useCallback(async () => {
    setIsGenerating(true);
    try {
      const podcast = await bc().forceDailyPodcast();
      if (podcast) {
        setCurrentPodcast(podcast);
        const audio = audioRef.current;
        if (audio) {
          audio.src = podcast.audio_url;
          audio.load();
          audio.play().then(() => setIsPlaying(true)).catch(() => {});
        }
      }
    } catch (e) {
      console.error("Failed to force-regenerate daily podcast:", e);
    }
    setIsGenerating(false);
  }, []);

  const handleAddToPlaylist = useCallback(async (playlistId: string, podcast: Podcast) => {
    await bc().addToPlaylist(playlistId, podcast.id);
    const updated = await bc().getPlaylists();
    setPlaylists(updated);
  }, []);

  const handleCreatePlaylist = useCallback(async (name: string): Promise<PlaylistInfo> => {
    const pl = await bc().createPlaylist(name);
    setPlaylists((prev) => [...prev, pl]);
    return pl;
  }, []);

  const handleRate = useCallback((podcastId: string, rating: number) => {
    bc().ratePodcast(podcastId, rating).catch(() => {});
  }, []);

  const showMiniPlayer = currentPodcast && page !== "player";

  return (
    <ResourceDirCtx.Provider value={resourceDir}>
    <div className="bc-root">
      <audio ref={audioRef} preload="metadata" />

      <NavBar page={page} setPage={setPage} />

      <div className={`bc-main ${showMiniPlayer ? "bc-with-mini" : ""}`}>
        {page === "player" && (
          <PlayerPage
            podcast={currentPodcast}
            setPodcast={setCurrentPodcast}
            isPlaying={isPlaying}
            currentTime={currentTime}
            duration={duration}
            lrcLines={lrcLines}
            audioRef={audioRef}
            onToggle={handleToggle}
            onSeek={handleSeek}
            playlists={playlists}
            onAddToPlaylist={handleAddToPlaylist}
            onCreatePlaylist={handleCreatePlaylist}
            onRate={handleRate}
            isGenerating={isGenerating}
            onGenerateDaily={handleGenerateDaily}
            onForceDaily={handleForceDaily}
            queue={queue}
            onPrev={handlePrevTrack}
            onNext={handleNextTrack}
            onPlayQueueItem={handlePlayPodcast}
          />
        )}
        {page === "library" && (
          <LibraryPage
            onPlay={handlePlayPodcast}
            playlists={playlists}
            onAddToPlaylist={handleAddToPlaylist}
            onCreatePlaylist={handleCreatePlaylist}
          />
        )}
        {page === "history" && <HistoryPage />}
        {page === "downloads" && <DownloadsPage onPlay={(p) => { setCurrentPodcast(p); setPage("player"); }} />}
        {page === "settings" && <SettingsPage />}
      </div>

      {showMiniPlayer && (
        <MiniPlayer
          podcast={currentPodcast}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          onToggle={handleToggle}
          onSeek={handleSeek}
          onNavigate={() => setPage("player")}
        />
      )}
    </div>
    </ResourceDirCtx.Provider>
  );
}
