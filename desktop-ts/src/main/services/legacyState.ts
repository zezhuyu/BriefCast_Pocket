import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveRssCsvPath } from "./rssCatalog";

export interface LegacyRssLink {
  id: number;
  link: string;
  country: string;
  category: string;
  lastCheck: number | null;
  available: boolean;
}

interface LegacyUser {
  id: string;
  password: string;
  preference: Record<string, unknown>;
  location: [number, number];
  createdAt: number;
}

interface LegacyToken {
  token: string;
  userId: string;
  deviceType: string;
  createdAt: number;
}

interface LegacyPlaylistState {
  id: string;
  userId: string;
  name: string;
  description: string;
  createdAt: number;
  podcastIds: string[];
}

interface LegacyState {
  users: LegacyUser[];
  tokens: LegacyToken[];
  playlists: LegacyPlaylistState[];
  rssLinks: LegacyRssLink[];
  envConfig: Record<string, string>;
}

function parseCsvLine(line: string): LegacyRssLink | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const firstComma = trimmed.indexOf(",");
  const secondComma = trimmed.indexOf(",", firstComma + 1);
  if (firstComma < 0 || secondComma < 0) {
    return null;
  }

  const country = trimmed.slice(0, firstComma).trim().toUpperCase();
  const category = trimmed.slice(firstComma + 1, secondComma).trim().toUpperCase();
  const link = trimmed.slice(secondComma + 1).trim();
  if (!country || !link.startsWith("http")) {
    return null;
  }

  return {
    id: -1,
    link,
    country,
    category,
    lastCheck: null,
    available: true
  };
}

function loadRssSeed(): LegacyRssLink[] {
  const csvPath = resolveRssCsvPath();
  if (!csvPath || !fs.existsSync(csvPath)) {
    return [];
  }

  const rows = fs
    .readFileSync(csvPath, "utf8")
    .split(/\r?\n/)
    .map((line) => parseCsvLine(line))
    .filter((row): row is LegacyRssLink => row !== null);

  return rows.map((row, index) => ({ ...row, id: index + 1 }));
}

function normalizeToken(authHeader: string | undefined): string {
  if (!authHeader) {
    return "";
  }
  const raw = authHeader.trim();
  if (raw.toLowerCase().startsWith("bearer ")) {
    return raw.slice("bearer ".length).trim();
  }
  return raw;
}

export class LegacyStateService {
  private readonly filePath: string;
  private state: LegacyState;

  constructor(baseDir: string) {
    const dbDir = path.join(baseDir, "data");
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.filePath = path.join(dbDir, "legacy-state.json");
    this.state = this.loadState();
  }

  private loadState(): LegacyState {
    if (!fs.existsSync(this.filePath)) {
      const initial: LegacyState = {
        users: [],
        tokens: [],
        playlists: [],
        rssLinks: loadRssSeed(),
        envConfig: {}
      };
      fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), "utf8");
      return initial;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as LegacyState;
      return {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
        playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
        rssLinks: Array.isArray(parsed.rssLinks) ? parsed.rssLinks : loadRssSeed(),
        envConfig: parsed.envConfig && typeof parsed.envConfig === "object" ? parsed.envConfig : {}
      };
    } catch {
      const fallback: LegacyState = {
        users: [],
        tokens: [],
        playlists: [],
        rssLinks: loadRssSeed(),
        envConfig: {}
      };
      fs.writeFileSync(this.filePath, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  private ensureUserPlaylists(userId: string): void {
    const existing = this.state.playlists.filter((playlist) => playlist.userId === userId);
    if (existing.length) {
      return;
    }

    const now = Date.now();
    this.state.playlists.push(
      {
        id: "favorite",
        userId,
        name: "favorite",
        description: "Favorite podcasts",
        createdAt: now,
        podcastIds: []
      },
      {
        id: "like",
        userId,
        name: "like",
        description: "Liked podcasts",
        createdAt: now + 1,
        podcastIds: []
      }
    );
    this.persist();
  }

  signup(userId: string, password: string, preference: Record<string, unknown> = {}): { token: string } {
    const trimmed = userId.trim();
    if (!trimmed) {
      throw new Error("user_id is required");
    }

    const existing = this.state.users.find((user) => user.id === trimmed);
    if (existing) {
      throw new Error("User already exists");
    }

    this.state.users.push({
      id: trimmed,
      password,
      preference,
      location: [0, 0],
      createdAt: Date.now()
    });

    const token = randomUUID();
    this.state.tokens.push({
      token,
      userId: trimmed,
      deviceType: "desktop",
      createdAt: Date.now()
    });
    this.ensureUserPlaylists(trimmed);
    this.persist();
    return { token };
  }

  signin(userId: string, _password: string): { token: string } {
    const trimmed = userId.trim();
    if (!trimmed) {
      throw new Error("user_id is required");
    }

    let user = this.state.users.find((entry) => entry.id === trimmed);
    if (!user) {
      user = {
        id: trimmed,
        password: _password,
        preference: {},
        location: [0, 0],
        createdAt: Date.now()
      };
      this.state.users.push(user);
    }

    const token = randomUUID();
    this.state.tokens.push({
      token,
      userId: user.id,
      deviceType: "desktop",
      createdAt: Date.now()
    });
    this.ensureUserPlaylists(user.id);
    this.persist();
    return { token };
  }

  signout(authHeader?: string): { ok: boolean } {
    const token = normalizeToken(authHeader);
    if (!token) {
      return { ok: true };
    }
    this.state.tokens = this.state.tokens.filter((entry) => entry.token !== token);
    this.persist();
    return { ok: true };
  }

  resolveUserId(authHeader?: string): string {
    const token = normalizeToken(authHeader);
    if (token) {
      const matched = this.state.tokens.find((entry) => entry.token === token);
      if (matched) {
        return matched.userId;
      }
    }

    if (this.state.users.length) {
      return this.state.users[0].id;
    }

    const fallbackUserId = "local";
    this.state.users.push({
      id: fallbackUserId,
      password: "",
      preference: {},
      location: [0, 0],
      createdAt: Date.now()
    });
    this.ensureUserPlaylists(fallbackUserId);
    this.persist();
    return fallbackUserId;
  }

  getUser(userId: string): LegacyUser {
    const user = this.state.users.find((entry) => entry.id === userId);
    if (user) {
      return user;
    }

    const created: LegacyUser = {
      id: userId,
      password: "",
      preference: {},
      location: [0, 0],
      createdAt: Date.now()
    };
    this.state.users.push(created);
    this.ensureUserPlaylists(userId);
    this.persist();
    return created;
  }

  getUserTokens(userId: string): LegacyToken[] {
    return this.state.tokens
      .filter((entry) => entry.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  issueToken(userId: string, deviceType = "desktop"): LegacyToken {
    this.getUser(userId);
    const token: LegacyToken = {
      token: randomUUID(),
      userId,
      deviceType,
      createdAt: Date.now()
    };
    this.state.tokens.push(token);
    this.persist();
    return token;
  }

  revokeToken(userId: string, token: string): { ok: boolean } {
    const before = this.state.tokens.length;
    this.state.tokens = this.state.tokens.filter((entry) => !(entry.userId === userId && entry.token === token));
    const changed = this.state.tokens.length !== before;
    if (changed) {
      this.persist();
    }
    return { ok: changed };
  }

  listPlaylists(userId: string): LegacyPlaylistState[] {
    this.ensureUserPlaylists(userId);
    return this.state.playlists
      .filter((playlist) => playlist.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getPlaylist(userId: string, playlistId: string): LegacyPlaylistState | null {
    this.ensureUserPlaylists(userId);
    return this.state.playlists.find((playlist) => playlist.userId === userId && playlist.id === playlistId) ?? null;
  }

  createPlaylist(userId: string, name: string, description = ""): LegacyPlaylistState {
    this.ensureUserPlaylists(userId);
    const playlist: LegacyPlaylistState = {
      id: randomUUID(),
      userId,
      name: name.trim() || "Untitled",
      description,
      createdAt: Date.now(),
      podcastIds: []
    };
    this.state.playlists.push(playlist);
    this.persist();
    return playlist;
  }

  updatePlaylist(userId: string, playlistId: string, name: string, description = ""): LegacyPlaylistState {
    const playlist = this.getPlaylist(userId, playlistId);
    if (!playlist) {
      throw new Error("Playlist not found");
    }
    playlist.name = name.trim() || playlist.name;
    playlist.description = description;
    this.persist();
    return playlist;
  }

  removePlaylist(userId: string, playlistId: string): { ok: boolean } {
    if (playlistId === "favorite" || playlistId === "like") {
      return { ok: false };
    }
    const before = this.state.playlists.length;
    this.state.playlists = this.state.playlists.filter(
      (playlist) => !(playlist.userId === userId && playlist.id === playlistId)
    );
    const changed = this.state.playlists.length !== before;
    if (changed) {
      this.persist();
    }
    return { ok: changed };
  }

  addToPlaylist(userId: string, playlistId: string, podcastId: string): { ok: boolean } {
    const playlist = this.getPlaylist(userId, playlistId);
    if (!playlist) {
      throw new Error("Playlist not found");
    }

    if (!playlist.podcastIds.includes(podcastId)) {
      playlist.podcastIds.push(podcastId);
      this.persist();
    }
    return { ok: true };
  }

  removeFromPlaylist(userId: string, playlistId: string, podcastId: string): { ok: boolean } {
    const playlist = this.getPlaylist(userId, playlistId);
    if (!playlist) {
      throw new Error("Playlist not found");
    }
    const before = playlist.podcastIds.length;
    playlist.podcastIds = playlist.podcastIds.filter((id) => id !== podcastId);
    const changed = playlist.podcastIds.length !== before;
    if (changed) {
      this.persist();
    }
    return { ok: changed };
  }

  getRssLinks(): LegacyRssLink[] {
    return this.state.rssLinks.slice().sort((a, b) => a.id - b.id);
  }

  getRssLink(id: number): LegacyRssLink | null {
    return this.state.rssLinks.find((entry) => entry.id === id) ?? null;
  }

  addRssLink(link: string, country: string, category: string): LegacyRssLink {
    const nextId = (this.state.rssLinks.at(-1)?.id ?? 0) + 1;
    const entry: LegacyRssLink = {
      id: nextId,
      link,
      country: country.toUpperCase(),
      category: category.toUpperCase(),
      lastCheck: null,
      available: true
    };
    this.state.rssLinks.push(entry);
    this.persist();
    return entry;
  }

  updateRssLink(id: number, link: string, country: string, category: string): LegacyRssLink {
    const target = this.getRssLink(id);
    if (!target) {
      throw new Error("RSS link not found");
    }
    target.link = link;
    target.country = country.toUpperCase();
    target.category = category.toUpperCase();
    this.persist();
    return target;
  }

  deleteRssLink(id: number): { ok: boolean } {
    const before = this.state.rssLinks.length;
    this.state.rssLinks = this.state.rssLinks.filter((entry) => entry.id !== id);
    const changed = this.state.rssLinks.length !== before;
    if (changed) {
      this.persist();
    }
    return { ok: changed };
  }

  checkRssLink(id: number): LegacyRssLink {
    const target = this.getRssLink(id);
    if (!target) {
      throw new Error("RSS link not found");
    }

    target.lastCheck = Date.now();
    target.available = target.link.startsWith("http");
    this.persist();
    return target;
  }

  refreshRssLinks(): { ok: boolean; checked: number } {
    for (const entry of this.state.rssLinks) {
      entry.lastCheck = Date.now();
      entry.available = entry.link.startsWith("http");
    }
    this.persist();
    return { ok: true, checked: this.state.rssLinks.length };
  }

  shouldCheckRssFeed(link: string, maxAgeMs: number): boolean {
    const normalized = link.trim();
    if (!normalized) return false;
    const row = this.state.rssLinks.find((entry) => entry.link === normalized);
    if (!row || row.lastCheck === null) {
      return true;
    }
    return Date.now() - row.lastCheck >= maxAgeMs;
  }

  markRssFeedChecked(link: string): void {
    const normalized = link.trim();
    if (!normalized) return;
    const now = Date.now();
    const existing = this.state.rssLinks.find((entry) => entry.link === normalized);
    if (existing) {
      existing.lastCheck = now;
      existing.available = normalized.startsWith("http");
      this.persist();
      return;
    }

    const nextId = (this.state.rssLinks.at(-1)?.id ?? 0) + 1;
    this.state.rssLinks.push({
      id: nextId,
      link: normalized,
      country: "US",
      category: "GENERAL",
      lastCheck: now,
      available: normalized.startsWith("http")
    });
    this.persist();
  }

  getEnvConfig(): Record<string, string> {
    return { ...this.state.envConfig };
  }

  setEnvConfig(patch: Record<string, string>): Record<string, string> {
    for (const [key, value] of Object.entries(patch)) {
      this.state.envConfig[key] = String(value);
    }
    this.persist();
    return { ...this.state.envConfig };
  }
}
