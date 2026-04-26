import http, { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { BriefcastAppService } from "./appService";
import { getProviderStatus } from "./providers";
import {
  AppSettings,
  DownloadSaveInput,
  HistoryTrackInput,
  MediaResourceFormat,
  SearchMode
} from "../../shared/types";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class ApiBridgeServer {
  private server?: http.Server;
  private readonly service: BriefcastAppService;
  private readonly port: number;

  constructor(service: BriefcastAppService, port = Number(process.env.BRIEFCAST_API_PORT ?? 5002)) {
    this.service = service;
    this.port = Number.isFinite(port) ? port : 5002;
  }

  start(): void {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });

    this.server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        // Keep desktop app usable even when a legacy backend already uses the compatibility port.
        console.warn(`[api-bridge] Port ${this.port} already in use. REST/GraphQL/MCP bridge not started.`);
        return;
      }
      console.error("[api-bridge] server error", error);
    });

    this.server.listen(this.port, "127.0.0.1", () => {
      console.log(`[embedded-api-bridge] listening on http://127.0.0.1:${this.port}`);
    });
  }

  stop(): void {
    if (!this.server) {
      return;
    }

    this.server.close();
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCors(res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        this.writeJson(res, 200, { ok: true, service: "briefcast-desktop-ts" });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        await this.handleRest(req, res, url);
        return;
      }

      if (await this.handleLegacyRest(req, res, url)) {
        return;
      }

      if (url.pathname === "/mcp/health" && req.method === "GET") {
        this.writeJson(res, 200, { ok: true, service: "briefcast-desktop-ts-mcp" });
        return;
      }

      if (url.pathname === "/graphql" && req.method === "POST") {
        await this.handleGraphql(req, res);
        return;
      }

      if (url.pathname === "/mcp" && req.method === "POST") {
        await this.handleMcp(req, res);
        return;
      }

      this.writeJson(res, 404, { error: "Not found" });
    } catch (error) {
      this.writeJson(res, 500, {
        error: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  }

  private async handleLegacyRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? "GET";
    const authHeader = req.headers.authorization;

    if (url.pathname.startsWith("/files/") && method === "GET") {
      const relative = decodeURIComponent(url.pathname.slice("/files/".length)).trim();
      const fileName = relative.split("/").pop() ?? "";
      if (!fileName) {
        this.writeJson(res, 404, { error: "File not found" });
        return true;
      }
      const file = await this.service.readMediaResourceBuffer(fileName);
      this.writeBinary(res, 200, file.mimeType, file.buffer);
      return true;
    }

    if (url.pathname === "/signup" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const userId = String(body.user_id ?? "");
      const password = String(body.password ?? "");
      const preference =
        body.preference && typeof body.preference === "object"
          ? (body.preference as Record<string, unknown>)
          : {};
      const result = this.service.signupLegacy(userId, password, preference);
      this.writeJson(res, 200, result);
      return true;
    }

    if (url.pathname === "/signin" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const userId = String(body.user_id ?? "");
      const password = String(body.password ?? "");
      const result = this.service.signinLegacy(userId, password);
      this.writeJson(res, 200, result);
      return true;
    }

    if (url.pathname === "/signout" && method === "GET") {
      this.writeJson(res, 200, this.service.signoutLegacy(authHeader));
      return true;
    }

    if (url.pathname === "/user" && method === "GET") {
      this.writeJson(res, 200, this.service.getLegacyUser(authHeader));
      return true;
    }

    if (url.pathname === "/token" && method === "GET") {
      this.writeJson(res, 200, this.service.getLegacyTokens(authHeader));
      return true;
    }

    if (url.pathname === "/token" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const userId = String(body.user_id ?? this.service.resolveLegacyUserId(authHeader));
      this.writeJson(res, 200, this.service.issueLegacyToken(userId));
      return true;
    }

    if (url.pathname === "/token" && method === "DELETE") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const userId = String(body.user_id ?? this.service.resolveLegacyUserId(authHeader));
      const token = String(body.token ?? "");
      this.writeJson(res, 200, this.service.revokeLegacyToken(authHeader, userId, token));
      return true;
    }

    if (url.pathname === "/generate" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const location = Array.isArray(body.location) ? (body.location as number[]) : undefined;
      const force = Boolean(body.force);
      const podcast = await this.service.generateLegacyPodcast(location, force);
      this.writeJson(res, 200, podcast);
      return true;
    }

    if (url.pathname.startsWith("/podcast/") && method === "GET") {
      const podcastId = decodeURIComponent(url.pathname.slice("/podcast/".length));
      const podcast = await this.service.getLegacyPodcast(podcastId);
      if (!podcast) {
        this.writeJson(res, 404, { error: "Podcast not found" });
      } else {
        this.writeJson(res, 200, podcast);
      }
      return true;
    }

    if (url.pathname === "/transition" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const id1 = String(body.id1 ?? "");
      const id2 = String(body.id2 ?? "");
      this.writeJson(res, 200, await this.service.getLegacyTransition(id1, id2));
      return true;
    }

    if (url.pathname === "/summary" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const pids = Array.isArray(body.pids) ? body.pids.map((value) => String(value)) : [];
      this.writeJson(res, 200, await this.service.getLegacySummary(pids));
      return true;
    }

    if (url.pathname === "/recommendations" && method === "GET") {
      this.writeJson(res, 200, await this.service.getLegacyRecommendations(undefined, 30));
      return true;
    }

    if (url.pathname.startsWith("/recommendations/") && method === "GET") {
      const podcastId = decodeURIComponent(url.pathname.slice("/recommendations/".length));
      this.writeJson(res, 200, await this.service.getLegacyRecommendations(podcastId, 30));
      return true;
    }

    if ((url.pathname === "/trending" || url.pathname === "/get_trending") && method === "GET") {
      this.writeJson(res, 200, await this.service.getLegacyTrending(30));
      return true;
    }

    if (url.pathname === "/search" && method === "GET") {
      const query = url.searchParams.get("q") ?? "";
      this.writeJson(res, 200, await this.service.getLegacySearch(query, 30));
      return true;
    }

    if (url.pathname === "/history" && method === "GET") {
      this.writeJson(res, 200, await this.service.getLegacyHistory(200));
      return true;
    }

    if ((url.pathname === "/refresh" || url.pathname === "/news/update") && (method === "GET" || method === "POST")) {
      const sync = await this.service.syncNews();
      this.writeJson(res, 200, {
        status: "success",
        fetched: sync.fetched,
        inserted: sync.inserted,
        updated: sync.updated,
        skipped: sync.skipped
      });
      return true;
    }

    if (url.pathname === "/playing" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const podcastId = String(body.podcast_id ?? "");
      const position = Number(body.position ?? 0);
      const userId = this.service.resolveLegacyUserId(authHeader);
      this.writeJson(res, 200, await this.service.markLegacyPlaying(userId, podcastId, position));
      return true;
    }

    if (url.pathname === "/played" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      this.writeJson(res, 200, await this.service.markLegacyPlayed(body));
      return true;
    }

    if (url.pathname === "/playlists" && method === "GET") {
      this.writeJson(res, 200, await this.service.getLegacyPlaylists(authHeader));
      return true;
    }

    if (url.pathname === "/playlist" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const name = String(body.name ?? "");
      const description = String(body.description ?? "");
      this.writeJson(res, 200, this.service.createLegacyPlaylist(authHeader, name, description));
      return true;
    }

    if (url.pathname === "/playlist" && method === "PUT") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const playlistId = String(body.id ?? body.playlist_id ?? "");
      const name = String(body.name ?? "");
      const description = String(body.description ?? "");
      this.writeJson(res, 200, this.service.updateLegacyPlaylist(authHeader, playlistId, name, description));
      return true;
    }

    if (url.pathname === "/playlist" && method === "DELETE") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const playlistId = String(body.id ?? body.playlist_id ?? "");
      this.writeJson(res, 200, this.service.removeLegacyPlaylist(authHeader, playlistId));
      return true;
    }

    if (url.pathname.startsWith("/playlist/") && method === "GET") {
      const playlistId = decodeURIComponent(url.pathname.slice("/playlist/".length));
      this.writeJson(res, 200, await this.service.getLegacyPlaylistItems(authHeader, playlistId));
      return true;
    }

    if (url.pathname.startsWith("/playlist/") && method === "POST") {
      const playlistId = decodeURIComponent(url.pathname.slice("/playlist/".length));
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const podcastId = String(body.podcast_id ?? "");
      this.writeJson(res, 200, this.service.addLegacyPlaylistItem(authHeader, playlistId, podcastId));
      return true;
    }

    if (url.pathname.startsWith("/playlist/") && method === "DELETE") {
      const playlistId = decodeURIComponent(url.pathname.slice("/playlist/".length));
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const podcastId = String(body.podcast_id ?? "");
      this.writeJson(res, 200, this.service.removeLegacyPlaylistItem(authHeader, playlistId, podcastId));
      return true;
    }

    if (url.pathname === "/rss" && method === "GET") {
      this.writeJson(res, 200, this.service.getLegacyRssLinks());
      return true;
    }

    if (url.pathname === "/rss" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const link = String(body.link ?? "");
      const country = String(body.country ?? "GLOBAL");
      const category = String(body.category ?? "GENERAL");
      this.writeJson(res, 200, this.service.addLegacyRssLink(link, country, category));
      return true;
    }

    if (url.pathname === "/rss/refresh" && method === "GET") {
      this.writeJson(res, 200, this.service.refreshLegacyRssLinks());
      return true;
    }

    if (url.pathname.startsWith("/rss/") && method === "PUT") {
      const id = Number(url.pathname.slice("/rss/".length));
      const body = (await this.readJson(req)) as Record<string, unknown>;
      this.writeJson(
        res,
        200,
        this.service.updateLegacyRssLink(id, String(body.link ?? ""), String(body.country ?? ""), String(body.category ?? ""))
      );
      return true;
    }

    if (url.pathname.startsWith("/rss/") && method === "DELETE") {
      const id = Number(url.pathname.slice("/rss/".length));
      this.writeJson(res, 200, this.service.deleteLegacyRssLink(id));
      return true;
    }

    if (url.pathname.endsWith("/check") && url.pathname.startsWith("/rss/") && method === "GET") {
      const idPart = url.pathname.slice("/rss/".length, -"/check".length);
      const id = Number(idPart);
      this.writeJson(res, 200, this.service.checkLegacyRssLink(id));
      return true;
    }

    if (url.pathname.startsWith("/rss/") && method === "GET") {
      const id = Number(url.pathname.slice("/rss/".length));
      const item = this.service.getLegacyRssLink(id);
      if (!item) {
        this.writeJson(res, 404, { error: "RSS link not found" });
      } else {
        this.writeJson(res, 200, item);
      }
      return true;
    }

    if (url.pathname === "/config" && method === "GET") {
      this.writeJson(res, 200, this.service.getLegacyConfig());
      return true;
    }

    if (url.pathname === "/config" && method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const patch = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
      this.writeJson(res, 200, this.service.setLegacyConfig(patch));
      return true;
    }

    return false;
  }

  private async handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if ((url.pathname === "/api/media/manifest" || url.pathname === "/api/resources/manifest") && req.method === "GET") {
      const manifest = await this.service.getMediaManifest();
      this.writeJson(res, 200, manifest);
      return;
    }

    if ((url.pathname === "/api/media/resource" || url.pathname === "/api/resources/file") && req.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      const format = (url.searchParams.get("format") ?? "base64") as MediaResourceFormat;
      const resource = await this.service.readMediaResource(name, format);
      this.writeJson(res, 200, resource);
      return;
    }

    if (url.pathname.startsWith("/api/resources/") && req.method === "GET") {
      const rawName = decodeURIComponent(url.pathname.slice("/api/resources/".length));
      if (!rawName || rawName === "manifest" || rawName === "file") {
        this.writeJson(res, 404, { error: "Resource endpoint not found" });
        return;
      }

      const resource = await this.service.readMediaResourceBuffer(rawName);
      this.writeBinary(res, 200, resource.mimeType, resource.buffer);
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      this.writeJson(res, 200, this.service.getSettings());
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      const body = await this.readJson(req);
      const saved = this.service.saveSettings(body as AppSettings);
      this.writeJson(res, 200, saved);
      return;
    }

    if (url.pathname === "/api/news/sync" && req.method === "POST") {
      const result = await this.service.syncNews();
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/news/search" && req.method === "GET") {
      const query = url.searchParams.get("query") ?? "";
      const mode = (url.searchParams.get("mode") ?? "hybrid") as SearchMode;
      const limit = Number(url.searchParams.get("limit") ?? "30");
      const result = await this.service.searchArticles(query, mode, Number.isFinite(limit) ? limit : 30);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/news/preference-search" && req.method === "POST") {
      const body = (await this.readJson(req)) as { description?: string; limit?: number };
      const description = (body?.description ?? "").trim();
      const limit = Number.isFinite(body?.limit) ? (body.limit as number) : 20;
      if (!description) {
        this.writeJson(res, 400, { error: "description is required" });
        return;
      }
      const result = await this.service.preferenceSearch(description, limit);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/news/financial" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "30");
      const result = await this.service.getFinancialNews(Number.isFinite(limit) ? limit : 30);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/briefings/generate" && req.method === "POST") {
      const result = await this.service.generateDailyBriefing();
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/briefings" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const result = this.service.getBriefings(Number.isFinite(limit) ? limit : 10);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/library/recommendations" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const result = await this.service.getRecommendations(Number.isFinite(limit) ? limit : 100);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/library/trending" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const result = await this.service.getTrending(Number.isFinite(limit) ? limit : 20);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const result = this.service.getHistory(Number.isFinite(limit) ? limit : 200);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/history/track" && req.method === "POST") {
      const body = (await this.readJson(req)) as HistoryTrackInput;
      const result = await this.service.trackHistory(body);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/downloads" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "500");
      const result = this.service.getDownloads(Number.isFinite(limit) ? limit : 500);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/downloads" && req.method === "POST") {
      const body = (await this.readJson(req)) as DownloadSaveInput;
      const result = await this.service.saveDownload(body);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/downloads" && req.method === "DELETE") {
      const id = url.searchParams.get("id") ?? "";
      const result = this.service.removeDownload(id);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/episode/generate" && req.method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const recommendationId = String(body.recommendationId ?? "");
      const result = await this.service.generateEpisode(recommendationId);
      this.writeJson(res, 200, result);
      return;
    }

    // ── Podcast ───────────────────────────────────────────────────────────────
    if (url.pathname === "/api/podcast/daily" && req.method === "GET") {
      // Return immediately from cache/DB; kick off background generation if needed.
      // Do NOT await generation — it can take minutes and would hang the request.
      const today = new Date().toISOString().slice(0, 10);
      const existing = this.service.getPodcastById(`daily-${today}`);
      if (existing && existing.audio_url) {
        this.writeJson(res, 200, existing);
      } else {
        // Trigger generation asynchronously (fire-and-forget)
        this.service.getDailyPodcast().catch((err: unknown) =>
          console.error("[apiBridge] background daily generation failed:", err)
        );
        this.writeJson(res, 204, null);
      }
      return;
    }

    if (url.pathname === "/api/podcast/force-daily" && req.method === "POST") {
      const result = await this.service.forceDailyPodcast();
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/podcast/generate-summary" && req.method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const podcastIds = Array.isArray(body.podcastIds) ? body.podcastIds.map(String) : [];
      const result = await this.service.generateSummaryPodcast(podcastIds);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/podcast/generate-audio" && req.method === "POST") {
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const recommendationId = String(body.recommendationId ?? "");
      const result = await this.service.generatePodcastAudio(recommendationId);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname.startsWith("/api/podcast/") && req.method === "GET") {
      const podcastId = decodeURIComponent(url.pathname.slice("/api/podcast/".length));
      const result = await this.service.getPodcastById(podcastId);
      if (!result) { this.writeJson(res, 404, { error: "Podcast not found" }); return; }
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname.startsWith("/api/podcast/") && url.pathname.endsWith("/rate") && req.method === "POST") {
      const podcastId = decodeURIComponent(url.pathname.slice("/api/podcast/".length, -"/rate".length));
      const body = (await this.readJson(req)) as Record<string, unknown>;
      const rating = Number(body.rating ?? 0);
      const result = await this.service.ratePodcast(podcastId, rating);
      this.writeJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      this.writeJson(res, 200, { ok: true, providerStatus: getProviderStatus() });
      return;
    }

    this.writeJson(res, 404, { error: "REST endpoint not found" });
  }

  private async handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as {
      query?: string;
      variables?: Record<string, unknown>;
    };

    const query = body.query ?? "";
    const variables = body.variables ?? {};

    try {
      if (/\bsyncNews\b/.test(query)) {
        const data = await this.service.syncNews();
        this.writeJson(res, 200, { data: { syncNews: data } });
        return;
      }

      if (/\bgenerateDailyBriefing\b/.test(query)) {
        const data = await this.service.generateDailyBriefing();
        this.writeJson(res, 200, { data: { generateDailyBriefing: data } });
        return;
      }

      if (/\bsaveSettings\b/.test(query)) {
        const nextSettings = (variables.input ?? variables.settings) as AppSettings;
        const data = this.service.saveSettings(nextSettings);
        this.writeJson(res, 200, { data: { saveSettings: data } });
        return;
      }

      if (/\bsettings\b/.test(query)) {
        const data = this.service.getSettings();
        this.writeJson(res, 200, { data: { settings: data } });
        return;
      }

      if (/\bsearchArticles\b/.test(query)) {
        const q = String(variables.query ?? "");
        const mode = String(variables.mode ?? "hybrid") as SearchMode;
        const limit = Number(variables.limit ?? 30);
        const data = await this.service.searchArticles(q, mode, Number.isFinite(limit) ? limit : 30);
        this.writeJson(res, 200, { data: { searchArticles: data } });
        return;
      }

      if (/\bbriefings\b/.test(query)) {
        const limit = Number(variables.limit ?? 10);
        const data = this.service.getBriefings(Number.isFinite(limit) ? limit : 10);
        this.writeJson(res, 200, { data: { briefings: data } });
        return;
      }

      if (/\brecommendations\b/.test(query)) {
        const limit = Number(variables.limit ?? 100);
        const data = await this.service.getRecommendations(Number.isFinite(limit) ? limit : 100);
        this.writeJson(res, 200, { data: { recommendations: data } });
        return;
      }

      if (/\bhistory\b/.test(query) && !/\btrackHistory\b/.test(query)) {
        const limit = Number(variables.limit ?? 200);
        const data = this.service.getHistory(Number.isFinite(limit) ? limit : 200);
        this.writeJson(res, 200, { data: { history: data } });
        return;
      }

      if (/\btrackHistory\b/.test(query)) {
        const input = (variables.input ?? variables.history) as HistoryTrackInput;
        const data = await this.service.trackHistory(input);
        this.writeJson(res, 200, { data: { trackHistory: data } });
        return;
      }

      if (/\bdownloads\b/.test(query) && !/\bsaveDownload\b/.test(query) && !/\bremoveDownload\b/.test(query)) {
        const limit = Number(variables.limit ?? 500);
        const data = this.service.getDownloads(Number.isFinite(limit) ? limit : 500);
        this.writeJson(res, 200, { data: { downloads: data } });
        return;
      }

      if (/\bsaveDownload\b/.test(query)) {
        const input = (variables.input ?? variables.download) as DownloadSaveInput;
        const data = await this.service.saveDownload(input);
        this.writeJson(res, 200, { data: { saveDownload: data } });
        return;
      }

      if (/\bremoveDownload\b/.test(query)) {
        const id = String(variables.id ?? "");
        const data = this.service.removeDownload(id);
        this.writeJson(res, 200, { data: { removeDownload: data } });
        return;
      }

      this.writeJson(res, 400, {
        errors: [{ message: "Unsupported GraphQL operation in compatibility bridge" }]
      });
    } catch (error) {
      this.writeJson(res, 500, {
        errors: [{ message: error instanceof Error ? error.message : "GraphQL execution error" }]
      });
    }
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rpc = (await this.readJson(req)) as JsonRpcRequest;
    const id = rpc.id ?? null;

    try {
      const method = rpc.method ?? "";
      const params = rpc.params ?? {};

      if (method === "initialize") {
        this.writeJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: "briefcast-desktop-ts-mcp",
              version: "0.1.0"
            }
          }
        });
        return;
      }

      if (method === "tools/list") {
        this.writeJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.getMcpToolList()
          }
        });
        return;
      }

      if (method === "tools/call") {
        const toolName = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const result = await this.callMcpTool(toolName, args);
        this.writeJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
          }
        });
        return;
      }

      const direct = await this.callMcpTool(method, params);
      this.writeJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: direct
      });
    } catch (error) {
      this.writeJson(res, 200, {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "MCP bridge error"
        }
      });
    }
  }

  private getMcpToolList(): Array<Record<string, unknown>> {
    return [
      {
        name: "settings.get",
        description: "Get current application settings",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "settings.save",
        description: "Save application settings",
        inputSchema: { type: "object", properties: { settings: { type: "object" } }, required: ["settings"] }
      },
      {
        name: "news.sync",
        description: "Fetch and index news from enabled sources",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "news.search",
        description: "Search indexed news by keyword, semantic vector, or hybrid",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            mode: { type: "string", enum: ["keyword", "semantic", "hybrid"] },
            limit: { type: "number" }
          },
          required: ["query"]
        }
      },
      {
        name: "briefing.generate",
        description: "Generate and store today daily briefing",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "briefing.list",
        description: "List historical briefings",
        inputSchema: { type: "object", properties: { limit: { type: "number" } } }
      },
      {
        name: "library.recommendations",
        description: "List recommended podcast-style items from indexed news",
        inputSchema: { type: "object", properties: { limit: { type: "number" } } }
      },
      {
        name: "history.list",
        description: "List listen history entries",
        inputSchema: { type: "object", properties: { limit: { type: "number" } } }
      },
      {
        name: "history.track",
        description: "Track a listen event for a recommendation",
        inputSchema: {
          type: "object",
          properties: {
            recommendationId: { type: "string" },
            progressSeconds: { type: "number" },
            durationSeconds: { type: "number" }
          },
          required: ["recommendationId"]
        }
      },
      {
        name: "downloads.list",
        description: "List downloaded podcast items",
        inputSchema: { type: "object", properties: { limit: { type: "number" } } }
      },
      {
        name: "downloads.save",
        description: "Save a recommendation to downloads",
        inputSchema: {
          type: "object",
          properties: {
            recommendationId: { type: "string" },
            imageResource: { type: "string" },
            audioResource: { type: "string" },
            lyricsResource: { type: "string" }
          },
          required: ["recommendationId"]
        }
      },
      {
        name: "downloads.remove",
        description: "Remove a downloaded podcast item",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"]
        }
      },
      {
        name: "media.manifest",
        description: "List bundled media resources from backend/db/resources",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "media.read",
        description: "Read a media resource from backend/db/resources",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            format: { type: "string", enum: ["base64", "text"] }
          },
          required: ["name"]
        }
      }
    ];
  }

  private async callMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "settings.get":
      case "settings:get":
        return this.service.getSettings();
      case "settings.save":
      case "settings:save":
        return this.service.saveSettings((args.settings ?? args) as AppSettings);
      case "news.sync":
      case "news:sync":
        return this.service.syncNews();
      case "news.search":
      case "news:search": {
        const query = String(args.query ?? "");
        const mode = String(args.mode ?? "hybrid") as SearchMode;
        const limit = Number(args.limit ?? 30);
        return this.service.searchArticles(query, mode, Number.isFinite(limit) ? limit : 30);
      }
      case "briefing.generate":
      case "briefing:generate":
        return this.service.generateDailyBriefing();
      case "briefing.list":
      case "briefing:list": {
        const limit = Number(args.limit ?? 10);
        return this.service.getBriefings(Number.isFinite(limit) ? limit : 10);
      }
      case "library.recommendations":
      case "library:recommendations": {
        const limit = Number(args.limit ?? 100);
        return this.service.getRecommendations(Number.isFinite(limit) ? limit : 100);
      }
      case "history.list":
      case "history:list": {
        const limit = Number(args.limit ?? 200);
        return this.service.getHistory(Number.isFinite(limit) ? limit : 200);
      }
      case "history.track":
      case "history:track": {
        const recommendationId = String(args.recommendationId ?? "");
        const progressSeconds =
          args.progressSeconds === undefined ? undefined : Number(args.progressSeconds);
        const durationSeconds =
          args.durationSeconds === undefined ? undefined : Number(args.durationSeconds);
        return this.service.trackHistory({
          recommendationId,
          progressSeconds,
          durationSeconds
        } satisfies HistoryTrackInput);
      }
      case "downloads.list":
      case "downloads:list": {
        const limit = Number(args.limit ?? 500);
        return this.service.getDownloads(Number.isFinite(limit) ? limit : 500);
      }
      case "downloads.save":
      case "downloads:save":
        return this.service.saveDownload({
          recommendationId: String(args.recommendationId ?? ""),
          imageResource: args.imageResource === undefined ? undefined : String(args.imageResource),
          audioResource: args.audioResource === undefined ? undefined : String(args.audioResource),
          lyricsResource: args.lyricsResource === undefined ? undefined : String(args.lyricsResource)
        } satisfies DownloadSaveInput);
      case "downloads.remove":
      case "downloads:remove":
        return this.service.removeDownload(String(args.id ?? ""));
      case "media.manifest":
      case "media:manifest":
        return this.service.getMediaManifest();
      case "media.read":
      case "media:read": {
        const name = String(args.name ?? "");
        const format = String(args.format ?? "base64") as MediaResourceFormat;
        return this.service.readMediaResource(name, format);
      }
      default:
        throw new Error(`Unsupported MCP method/tool: ${name}`);
    }
  }

  private setCors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (!chunks.length) {
      return {};
    }

    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON body");
    }
  }

  private writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(payload);
  }

  private writeBinary(res: ServerResponse, statusCode: number, contentType: string, body: Buffer): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", contentType);
    res.end(body);
  }
}
