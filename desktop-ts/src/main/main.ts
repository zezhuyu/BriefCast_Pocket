import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { BriefcastAppService } from "./services/appService";
import { ApiBridgeServer } from "./services/apiBridge";
import {
  AppSettings,
  DownloadSaveInput,
  HistoryTrackInput,
  MediaResourceFormat,
  SearchMode,
  UserPreferenceSettings,
} from "../shared/types";

function loadEnvironmentFile(): void {
  const explicitEnv = process.env.BRIEFCAST_ENV_FILE;
  const candidates = [
    explicitEnv,
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.resourcesPath, ".env")
  ].filter((value): value is string => Boolean(value));

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    loadDotenv({ path: filePath, override: false }); // env vars set by npm scripts take precedence over .env
    console.log(`[env] loaded ${filePath}`);
    return;
  }

  console.log("[env] no .env file found (using process environment only)");
}

loadEnvironmentFile();

const frontendDevServerUrl = process.env.FRONTEND_DEV_SERVER_URL || process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(frontendDevServerUrl);
let mainWindow: BrowserWindow | null = null;
let service: BriefcastAppService;
let apiBridge: ApiBridgeServer | null = null;

function resolveAppIconPath(): string | undefined {
  const candidate = path.resolve(__dirname, "../assets/app-icon.png");
  return fs.existsSync(candidate) ? candidate : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadDevUrlWithRetry(win: BrowserWindow, url: string): Promise<void> {
  const maxAttempts = 60;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await win.loadURL(url);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_CONNECTION_REFUSED")) throw error;
      if (attempt === maxAttempts) throw error;
      await sleep(1000);
    }
  }
}

async function createWindow(): Promise<void> {
  const appIconPath = resolveAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1000,
    minHeight: 720,
    backgroundColor: "#1e1b4b",
    icon: appIconPath,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false  // allow file:// audio URLs from renderer
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    const devUrl = frontendDevServerUrl as string;
    try {
      await loadDevUrlWithRetry(mainWindow, devUrl);
    } catch {
      await mainWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          "<html><body style='font-family:sans-serif;padding:24px'><h2>Renderer not ready</h2><p>Vite dev server did not become available.</p></body></html>"
        )}`
      );
    }
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../frontend/out/index.html"));
  }
}

function scheduleNewsSyncEvery6Hours(svc: BriefcastAppService): void {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const ONE_HOUR_MS = 60 * 60 * 1000;

  async function runSync(): Promise<void> {
    console.log("[news-scheduler] running 6-hour news sync + embed…");
    try {
      const result = await svc.syncNews();
      console.log(`[news-scheduler] sync done — fetched:${result.fetched} inserted:${result.inserted} skipped:${result.skipped}`);
    } catch (err) {
      console.error("[news-scheduler] sync failed:", err);
    }
  }

  async function runImageBackfill(): Promise<void> {
    console.log("[news-scheduler] backfilling missing images…");
    try {
      const updated = await svc.backfillMissingImages(100);
      console.log(`[news-scheduler] image backfill done — updated:${updated}`);
    } catch (err) {
      console.error("[news-scheduler] image backfill failed:", err);
    }
  }

  // On startup: only run an immediate sync if it has been ≥6 hours since the
  // last completed sync (or if there has never been one). Otherwise schedule
  // the next sync for the remaining time so restarts don't reset the interval.
  const lastSync = svc.getLastSyncTime();
  const elapsed = Date.now() - lastSync;
  const startupDelay = elapsed >= SIX_HOURS_MS
    ? 30_000                        // overdue — sync soon after boot
    : SIX_HOURS_MS - elapsed;       // not yet due — wait out the remainder
  console.log(`[news-scheduler] next startup sync in ${Math.round(startupDelay / 60000)} min (last sync ${Math.round(elapsed / 60000)} min ago)`);
  setTimeout(runSync, startupDelay);

  // Image backfill 2 minutes after startup (give sync time to finish)
  setTimeout(runImageBackfill, 120_000);

  // Then repeat every 6 hours for news sync
  setInterval(runSync, SIX_HOURS_MS);

  // Image backfill every hour to gradually fill in missing images
  setInterval(runImageBackfill, ONE_HOUR_MS);
}

function scheduleDailyGeneration(svc: BriefcastAppService): void {
  function msUntilHour(hour: number, minute = 0): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
  }

  // 8:00am — generate the daily briefing
  function scheduleBriefing(): void {
    setTimeout(async () => {
      console.log("[scheduler] 8:00am — generating daily briefing");
      try {
        await svc.forceDailyPodcast();
        await svc.cleanupOldPodcastFiles();
      } catch (err) {
        console.error("[scheduler] daily briefing failed:", err);
      }
      scheduleBriefing();
    }, msUntilHour(8, 0));
  }

  // 8:30am — refresh topic preferences from listening behavior
  function schedulePreferenceRefresh(): void {
    setTimeout(async () => {
      console.log("[scheduler] 8:30am — refreshing topic preferences from behavior");
      try {
        await svc.refreshTopicsFromBehavior();
      } catch (err) {
        console.error("[scheduler] preference refresh failed:", err);
      }
      schedulePreferenceRefresh();
    }, msUntilHour(8, 30));
  }

  scheduleBriefing();
  schedulePreferenceRefresh();
}

function registerIpcHandlers(): void {
  // ── Settings ──────────────────────────────────────────────────────────────
  ipcMain.handle("settings:get", () => service.getSettings());
  ipcMain.handle("settings:save", (_e, s: AppSettings) => {
    const saved = service.saveSettings(s);
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("settings:changed", saved));
    return saved;
  });

  // ── News ──────────────────────────────────────────────────────────────────
  ipcMain.handle("news:sync", () => service.syncNews());
  ipcMain.handle("news:search", (_e, q: string, mode: SearchMode, limit?: number) =>
    service.searchArticles(q, mode, limit)
  );
  ipcMain.handle("news:preference-search", (_e, description: string, limit?: number) =>
    service.preferenceSearch(description, limit)
  );
  ipcMain.handle("news:financial", (_e, limit?: number) => service.getFinancialNews(limit));

  // ── Text briefing ─────────────────────────────────────────────────────────
  ipcMain.handle("briefing:generate", () => service.generateDailyBriefing());
  ipcMain.handle("briefing:list", (_e, limit?: number) => service.getBriefings(limit));

  // ── Library ───────────────────────────────────────────────────────────────
  ipcMain.handle("library:recommendations", (_e, limit?: number) => service.getRecommendations(limit));
  ipcMain.handle("library:trending", (_e, limit?: number) => service.getTrending(limit));

  // ── History ───────────────────────────────────────────────────────────────
  ipcMain.handle("history:list", (_e, limit?: number) => service.getHistory(limit));
  ipcMain.handle("history:track", (_e, input: HistoryTrackInput) => service.trackHistory(input));

  // ── Downloads ─────────────────────────────────────────────────────────────
  ipcMain.handle("downloads:list", (_e, limit?: number) => service.getDownloads(limit));
  ipcMain.handle("downloads:save", (_e, input: DownloadSaveInput) => service.saveDownload(input));
  ipcMain.handle("downloads:remove", (_e, id: string) => service.removeDownload(id));

  // ── Media resources ───────────────────────────────────────────────────────
  ipcMain.handle("media:manifest", () => service.getMediaManifest());
  ipcMain.handle("media:read", (_e, name: string, format?: MediaResourceFormat) =>
    service.readMediaResource(name, format ?? "base64")
  );

  // ── Podcast audio generation ──────────────────────────────────────────────
  ipcMain.handle("episode:generate", (_e, recommendationId: string) =>
    service.generateEpisode(recommendationId)
  );
  ipcMain.handle("podcast:get-daily", () => service.getDailyPodcast());
  ipcMain.handle("podcast:force-daily", () => service.forceDailyPodcast());
  ipcMain.handle("podcast:generate-audio", (_e, recommendationId: string) =>
    service.generatePodcastAudio(recommendationId)
  );
  ipcMain.handle("podcast:generate-summary", (_e, podcastIds: string[]) =>
    service.generateSummaryPodcast(podcastIds)
  );
  ipcMain.handle("podcast:get", (_e, podcastId: string) => service.getPodcastById(podcastId));
  ipcMain.handle("podcast:rate", (_e, podcastId: string, rating: number) =>
    service.ratePodcast(podcastId, rating)
  );

  // ── Playlists ─────────────────────────────────────────────────────────────
  ipcMain.handle("playlist:list", () => service.getPlaylists());
  ipcMain.handle("playlist:create", (_e, name: string, description?: string) =>
    service.createPlaylist(name, description)
  );
  ipcMain.handle("playlist:delete", (_e, playlistId: string) => service.deletePlaylist(playlistId));
  ipcMain.handle("playlist:add", (_e, playlistId: string, podcastId: string) =>
    service.addToPlaylist(playlistId, podcastId)
  );
  ipcMain.handle("playlist:remove", (_e, playlistId: string, podcastId: string) =>
    service.removeFromPlaylist(playlistId, podcastId)
  );

  // ── User profile ──────────────────────────────────────────────────────────
  ipcMain.handle("user:get", () => service.getUserProfile());
  ipcMain.handle("user:update", (_e, prefs: Partial<UserPreferenceSettings>) =>
    service.updateUserProfile(prefs)
  );

}

app
  .whenReady()
  .then(async () => {
    service = new BriefcastAppService(app.getPath("userData"));
    const appIconPath = resolveAppIconPath();
    if (appIconPath && process.platform === "darwin") {
      app.dock.setIcon(appIconPath);
    }

    const enableApiBridge = process.env.BRIEFCAST_ENABLE_API_BRIDGE === "1";
    if (enableApiBridge) {
      apiBridge = new ApiBridgeServer(service);
      apiBridge.start();
    } else {
      console.log("[embedded-api-bridge] disabled (set BRIEFCAST_ENABLE_API_BRIDGE=1 to enable)");
    }

    registerIpcHandlers();
    await createWindow();
    scheduleNewsSyncEvery6Hours(service);
    scheduleDailyGeneration(service);

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  })
  .catch((error) => {
    console.error("[app] Startup failure:", error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  apiBridge?.stop();
  apiBridge = null;
});

process.on("unhandledRejection", (reason) => {
  console.error("[app] Unhandled rejection:", reason);
});
