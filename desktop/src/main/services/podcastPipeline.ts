/**
 * Podcast generation pipeline.
 * Mirrors the Python backend's podcast.py / daily.py:
 *   opening.wav → starting.wav → [story + transition]* → ending.wav → combined → LRC
 *
 * Resource audio/text files from assets/audio and assets/transcript are used as-is for the
 * intro/outro bookends. TTS segments are written to temp files and everything
 * is joined by ffmpeg into a single 32kbps mono 16kHz MP3 (matching the backend).
 *
 * Background music:
 *   - Opening: op.wav plays at 0.20 volume; greeting speech starts after 31s delay
 *   - Ending:  ed.wav plays at 0.25 volume; ending speech starts after 3.5s delay
 *
 * Weather forecast (if location provided as "lat,lon"):
 *   - Fetched from wttr.in, summarised by LLM, synthesised as TTS
 *   - Inserted between greeting and starting.wav in the opening
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AppSettings } from "../../shared/types";
import { generateText, synthesizeSpeech } from "./providers";

export interface PipelinePodcast {
  id: string;
  title: string;
  audioPath: string;   // absolute path to final .mp3
  lrcPath: string;     // absolute path to .lrc transcript
  durationSeconds: number;
  publishedAt: number;
}

interface ArticleInput {
  id: string;
  title: string;
  summary: string;
  sourceName: string;
  url: string;
  publishedAt: number;
}

export interface PipelineOptions {
  baseDir: string;
  resourceDir: string;  // path to assets root (contains audio/, transcript/, image/)
  settings: AppSettings;
  articles: ArticleInput[];
  title?: string;
  isSummary?: boolean;
  location?: string;    // "lat,lon" — enables weather forecast in opening
  skipIntroOutro?: boolean; // if true, skip opening/ending segments (for single/summary podcasts)
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getGreeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 21) return "Good evening";
  return "Good evening";
}

function getDayPart(hour: number): string {
  if (hour >= 5 && hour < 12) return "day";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

function getOrdinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatDateLong(d: Date): string {
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const month = d.toLocaleDateString("en-US", { month: "long" });
  const day = getOrdinal(d.getDate());
  return `${weekday}, ${month} ${day} ${d.getFullYear()}`;
}

/** Parse PCM WAV header to get duration in seconds. Handles non-standard chunk ordering. */
function wavDurationSeconds(buf: Buffer): number {
  if (buf.length < 44 || buf.slice(0, 4).toString() !== "RIFF") return 0;
  let offset = 12;
  let sampleRate = 0, numChannels = 0, bitsPerSample = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.slice(offset, offset + 4).toString("ascii");
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      numChannels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      if (!sampleRate || !numChannels || !bitsPerSample) return 0;
      return chunkSize / (sampleRate * numChannels * (bitsPerSample / 8));
    }
    offset += 8 + (chunkSize % 2 === 0 ? chunkSize : chunkSize + 1);
  }
  return 0;
}

/** LRC timestamp string from seconds. */
function secondsToLrcTs(t: number): string {
  const mm = Math.floor(t / 60).toString().padStart(2, "0");
  const ss = Math.floor(t % 60).toString().padStart(2, "0");
  const cs = Math.round((t % 1) * 100).toString().padStart(2, "0");
  return `[${mm}:${ss}.${cs}]`;
}

/** Shift every timestamp in an LRC string by offsetSeconds. */
function offsetLrc(lrc: string, offsetSeconds: number): string {
  return lrc
    .split("\n")
    .map((line) => {
      const m = line.match(/^\[(\d+):(\d+)\.(\d+)\](.*)/);
      if (!m) return line;
      const t = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3]) / 100 + offsetSeconds;
      return `${secondsToLrcTs(t)}${m[4]}`;
    })
    .join("\n");
}

/** Estimate speaking duration from text (~2.8 words/sec ≈ 168 wpm). */
function textToLrc(text: string, startSeconds = 0): { lrc: string; endSeconds: number } {
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  let cursor = startSeconds;
  const lines: string[] = [];
  for (const sentence of sentences) {
    lines.push(`${secondsToLrcTs(cursor)}${sentence}`);
    const words = sentence.split(/\s+/).filter(Boolean).length;
    cursor += Math.max(0.5, words / 2.8);
  }
  return { lrc: lines.join("\n"), endSeconds: cursor };
}

// ── Weather ────────────────────────────────────────────────────────────────────

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    precipitation_probability?: number[];
    weather_code?: number[];
  };
  timezone?: string;
  timezone_abbreviation?: string;
}

function weatherCodeToDescription(code: number): string {
  if (code === 0) return "clear sky";
  if (code === 1) return "mainly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code <= 9) return "foggy";
  if (code <= 19) return "drizzle";
  if (code <= 29) return "rain";
  if (code <= 39) return "snow";
  if (code <= 49) return "foggy";
  if (code <= 59) return "drizzle";
  if (code <= 69) return "rain";
  if (code <= 79) return "snow";
  if (code <= 84) return "rain showers";
  if (code <= 86) return "snow showers";
  if (code <= 99) return "thunderstorm";
  return "mixed conditions";
}

function windDirectionToText(degrees: number): string {
  const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return dirs[Math.round(degrees / 45) % 8];
}

/** Fetch structured weather data from Open-Meteo API for a "lat,lon" location string. */
async function fetchWeatherData(location: string): Promise<string | null> {
  try {
    const [lat, lon] = location.split(",").map((s) => parseFloat(s.trim()));
    if (!isFinite(lat) || !isFinite(lon)) return null;

    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m",
      hourly: "temperature_2m,precipitation_probability,weather_code",
      forecast_days: "1",
      timezone: "auto",
    });

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      headers: { "User-Agent": "BriefCast/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const data = await res.json() as OpenMeteoResponse;
    const cur = data.current;
    if (!cur) return null;

    const condition = cur.weather_code !== undefined ? weatherCodeToDescription(cur.weather_code) : "unknown";
    const windDir = cur.wind_direction_10m !== undefined ? windDirectionToText(cur.wind_direction_10m) : "";

    // Build hourly morning/afternoon/evening summary
    const times = data.hourly?.time ?? [];
    const hourlyTemps = data.hourly?.temperature_2m ?? [];
    const hourlyPop = data.hourly?.precipitation_probability ?? [];
    const hourlyCodes = data.hourly?.weather_code ?? [];

    function hourSummary(targetHour: number): string {
      const idx = times.findIndex((t) => {
        const h = new Date(t).getHours();
        return h === targetHour;
      });
      if (idx < 0) return "";
      const t = hourlyTemps[idx];
      const pop = hourlyPop[idx];
      const cond = hourlyCodes[idx] !== undefined ? weatherCodeToDescription(hourlyCodes[idx]) : "";
      return `${cond}, ${t !== undefined ? Math.round(t) : "?"}°C, ${pop !== undefined ? pop : "?"}% chance of rain`;
    }

    const summary = [
      `Current conditions: ${condition}.`,
      cur.temperature_2m !== undefined ? `Temperature: ${Math.round(cur.temperature_2m)}°C (feels like ${Math.round(cur.apparent_temperature ?? cur.temperature_2m)}°C).` : "",
      cur.wind_speed_10m !== undefined ? `Wind: ${Math.round(cur.wind_speed_10m)} km/h from the ${windDir}.` : "",
      cur.precipitation !== undefined ? `Current precipitation: ${cur.precipitation} mm.` : "",
      cur.relative_humidity_2m !== undefined ? `Humidity: ${cur.relative_humidity_2m}%.` : "",
      hourSummary(9) ? `Morning (9am): ${hourSummary(9)}.` : "",
      hourSummary(14) ? `Afternoon (2pm): ${hourSummary(14)}.` : "",
      hourSummary(20) ? `Evening (8pm): ${hourSummary(20)}.` : "",
    ].filter(Boolean).join(" ");

    return summary || null;
  } catch {
    return null;
  }
}

/** Ask the LLM to rewrite structured weather data as a radio weather forecast. */
async function buildWeatherScript(settings: AppSettings, rawWeather: string): Promise<string | null> {
  const systemPrompt = [
    "You are a weather reporter broadcasting a weather forecast to listeners.",
    "Write a natural, spoken weather forecast script using the provided weather data.",
    "Include: current temperature in Celsius, weather conditions, wind speed and direction, and precipitation chance.",
    "Add a brief morning, afternoon, and evening outlook.",
    "Use a conversational broadcast tone. Write all numbers as words or natural speech.",
    "Do NOT add any markup, asterisks, brackets, or stage directions.",
    "Output only the spoken forecast text, nothing else.",
  ].join(" ");
  const prompt = `${systemPrompt}\n\nWeather data:\n${rawWeather}`;
  try {
    const text = await generateText(settings, prompt);
    return text.trim() || null;
  } catch {
    return null;
  }
}

// ── ffmpeg ────────────────────────────────────────────────────────────────────

const FFMPEG_CANDIDATES = [
  "ffmpeg",
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

async function findFfmpeg(): Promise<string | null> {
  for (const cmd of FFMPEG_CANDIDATES) {
    try {
      await runProcess(cmd, ["-version"], undefined);
      return cmd;
    } catch {
      // try next
    }
  }
  return null;
}

function runProcess(cmd: string, args: string[], stdin?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: stdin ? ["pipe", "ignore", "pipe"] : ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => reject(new Error(`${cmd} error: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-300)}`));
      else resolve();
    });
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/**
 * Concatenate audio files using ffmpeg concat demuxer.
 * Output: 32kbps mono 16kHz MP3 (matching backend).
 */
async function ffmpegConcat(ffmpeg: string, inputFiles: string[], outputPath: string): Promise<void> {
  const listPath = outputPath + ".concat.txt";
  const listContent = inputFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, listContent, "utf8");
  try {
    await runProcess(ffmpeg, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:a", "libmp3lame", "-b:a", "32k", "-ac", "1", "-ar", "16000",
      outputPath,
    ]);
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }
}

/**
 * Mix a background music track with speech segments using ffmpeg amix + adelay.
 * The background plays at bgVolume throughout; speech starts speechDelayMs into the track.
 * Output: 32kbps mono 16kHz MP3.
 *
 * @param bgFile       - Background music WAV (op.wav or ed.wav)
 * @param speechFiles  - Ordered speech audio segments to be concatenated and mixed in
 * @param bgVolume     - Background volume (0.20 for intro, 0.25 for outro)
 * @param speechDelayMs- Milliseconds to delay speech after track start (31000 for intro, 3500 for outro)
 * @param outputPath   - Output MP3 path
 */
async function ffmpegMixWithBg(
  ffmpeg: string,
  bgFile: string,
  speechFiles: string[],
  bgVolume: number,
  speechDelayMs: number,
  outputPath: string,
): Promise<void> {
  if (speechFiles.length === 0) {
    // No speech — just re-encode the background
    await runProcess(ffmpeg, [
      "-y", "-i", bgFile,
      "-c:a", "libmp3lame", "-b:a", "32k", "-ac", "1", "-ar", "16000",
      outputPath,
    ]);
    return;
  }

  // Build inputs list: background first, then speech segments
  const inputArgs: string[] = ["-i", bgFile];
  for (const f of speechFiles) {
    inputArgs.push("-i", f);
  }

  // Build filter_complex:
  //   1. Concatenate all speech segments → [speech_raw]
  //   2. Resample+mono → [speech]
  //   3. Delay speech → [speech_delayed]
  //   4. Lower background volume → [bg]
  //   5. Mix bg + delayed speech → [out]
  const n = speechFiles.length;
  const speechInputLabels = speechFiles.map((_, i) => `[${i + 1}:a]`).join("");
  const filterParts: string[] = [];

  if (n === 1) {
    filterParts.push(`[1:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[speech]`);
  } else {
    filterParts.push(
      `${speechInputLabels}concat=n=${n}:v=0:a=1,aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[speech]`,
    );
  }
  filterParts.push(`[speech]adelay=${speechDelayMs}|${speechDelayMs}[speech_delayed]`);
  filterParts.push(`[0:a]volume=${bgVolume}[bg]`);
  filterParts.push(`[bg][speech_delayed]amix=inputs=2:duration=longest:dropout_transition=2[out]`);

  await runProcess(ffmpeg, [
    "-y",
    ...inputArgs,
    "-filter_complex", filterParts.join(";"),
    "-map", "[out]",
    "-c:a", "libmp3lame", "-b:a", "32k", "-ac", "1", "-ar", "16000",
    outputPath,
  ]);
}

// ── Script builders ───────────────────────────────────────────────────────────

async function buildStoryScript(settings: AppSettings, article: ArticleInput): Promise<string> {
  const prompt = [
    "You are a professional BBC news correspondent delivering an in-depth radio news report.",
    "",
    "Write a detailed 1-2 minute spoken news report (approximately 200-300 words) based on the following story.",
    "",
    "Structure your report like a BBC journalist:",
    "1. Lead with the key news hook - what happened and why it matters",
    "2. Provide essential context and background",
    "3. Include relevant details, facts, or figures from the summary",
    "4. Explain the implications or what this means for listeners",
    "5. End with what to watch for next or a forward-looking statement",
    "",
    "Style guidelines:",
    "- Use a professional, authoritative but accessible tone",
    "- Write for the ear, not the eye - use natural spoken English",
    "- Vary sentence length for rhythm and engagement",
    "- No markdown, asterisks, bullet points, or special formatting",
    "- Output plain spoken text only, ready for text-to-speech",
    "",
    `Story Title: ${article.title}`,
    `Source: ${article.sourceName}`,
    `Details: ${article.summary || "No additional details available."}`,
  ].join("\n");
  return generateText(settings, prompt);
}

async function buildTransition(settings: AppSettings, fromTitle: string, toTitle: string): Promise<string> {
  const prompt = [
    "Write a 1-2 sentence radio-host transition between two news stories.",
    "Be natural and conversational. Output plain text only.",
    `From: "${fromTitle}"`,
    `To: "${toTitle}"`,
  ].join("\n");
  try {
    return await generateText(settings, prompt);
  } catch {
    return "Now, let's turn to our next story.";
  }
}

async function buildSummaryScript(settings: AppSettings, articles: ArticleInput[]): Promise<string> {
  const summaries = articles.map((a, i) => `${i + 1}. ${a.title}\n   ${a.summary || "No details available."}`).join("\n\n");
  const prompt = [
    "You are a BBC World Service news anchor delivering a comprehensive news briefing.",
    "",
    `Write a detailed ${articles.length > 3 ? "3-5" : "2-3"} minute spoken news summary (approximately ${articles.length > 3 ? "400-600" : "250-400"} words) covering these stories.`,
    "",
    "Structure your briefing like a professional news program:",
    "1. Open with a brief overview of the major themes in today's news",
    "2. Cover each story with:",
    "   - The key development and why it matters",
    "   - Essential context or background",
    "   - Implications for listeners",
    "3. Use smooth transitions between stories to maintain flow",
    "4. Close with a forward-looking statement about what to watch",
    "",
    "Style guidelines:",
    "- Professional, authoritative but accessible BBC-style tone",
    "- Write for the ear - natural spoken English with varied rhythm",
    "- Connect related stories where appropriate",
    "- No markdown, asterisks, bullet points, or special formatting",
    "- Output plain spoken text only, ready for text-to-speech",
    "",
    "Stories to cover:",
    summaries,
  ].join("\n");
  return generateText(settings, prompt);
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

export async function generateDailyPodcast(opts: PipelineOptions): Promise<PipelinePodcast> {
  const { baseDir, resourceDir, settings, articles, isSummary = false, location, skipIntroOutro = false } = opts;

  console.log(`[pipeline] starting — articles:${articles.length} isSummary:${isSummary} skipIntroOutro:${skipIntroOutro} tts:${settings.tts.provider} location:${location ?? "none"}`);

  const audioDir = path.join(baseDir, "audio");
  const lrcDir = path.join(baseDir, "transcript");
  const tmpDir = path.join(os.tmpdir(), `briefcast-${randomUUID()}`);
  await Promise.all([
    fs.mkdir(audioDir, { recursive: true }),
    fs.mkdir(lrcDir, { recursive: true }),
    fs.mkdir(tmpDir, { recursive: true }),
  ]);

  const ffmpeg = await findFfmpeg();
  console.log("[pipeline] ffmpeg:", ffmpeg ?? "not found (fallback concat)");

  const tempFiles: string[] = [];
  const audioFiles: string[] = [];  // ordered list for final ffmpeg concat
  const lrcParts: string[] = [];
  let cursor = 0;

  // ── Resource loader helpers ───────────────────────────────────────────────
  // Primary lookup follows bundled assets layout:
  //   <resourceDir>/audio/*.wav
  //   <resourceDir>/transcript/*.lrc
  // Fallback to <resourceDir>/<name> for backward compatibility.
  const resourceAudio = async (name: string): Promise<Buffer | null> => {
    const candidates = [
      path.join(resourceDir, "audio", name),
      path.join(resourceDir, name),
    ];
    for (const candidate of candidates) {
      try {
        return await fs.readFile(candidate);
      } catch {
        // try next candidate
      }
    }
    console.warn(`[pipeline] resource audio not found: ${name}`);
    return null;
  };
  const resourceText = async (name: string): Promise<string | null> => {
    const candidates = [
      path.join(resourceDir, "transcript", name),
      path.join(resourceDir, name),
    ];
    for (const candidate of candidates) {
      try {
        return await fs.readFile(candidate, "utf8");
      } catch {
        // try next candidate
      }
    }
    return null;
  };

  // ── Skip intro/outro for single podcast or summary (just content) ─────────
  if (skipIntroOutro) {
    // Simple mode: just the news content with news host style narration
    if (isSummary) {
      // Summary: combine all articles into one cohesive briefing
      let script: string;
      try {
        script = await buildSummaryScript(settings, articles);
      } catch {
        script = articles.map((a) => `${a.title}. ${a.summary || ""}`).join(" Next, ");
      }
      console.log("[pipeline] synthesising summary (no intro/outro)…");
      const audio = await synthesizeSpeech(settings, script);
      const ext = audio.mimeType.includes("aiff") ? "aiff" : "mp3";
      const p = path.join(tmpDir, `summary.${ext}`);
      await fs.writeFile(p, audio.buffer);
      tempFiles.push(p);
      audioFiles.push(p);
      const lrc = textToLrc(script, cursor);
      lrcParts.push(lrc.lrc);
      cursor = lrc.endSeconds;
    } else {
      // Single/multi article: narrate each story, no transitions between (it's typically just 1)
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        let script: string;
        console.log(`[pipeline] story ${i + 1}/${articles.length}: "${article.title.slice(0, 60)}" (no intro/outro)`);
        try {
          script = await buildStoryScript(settings, article);
        } catch (err) {
          console.warn(`[pipeline] buildStoryScript failed:`, err);
          script = `${article.title}. ${article.summary || "More details available online."}`;
        }

        console.log(`[pipeline] synthesising story ${i + 1}…`);
        const audio = await synthesizeSpeech(settings, script);
        const ext = audio.mimeType.includes("aiff") ? "aiff" : "mp3";
        const p = path.join(tmpDir, `story_${i}.${ext}`);
        await fs.writeFile(p, audio.buffer);
        tempFiles.push(p);
        audioFiles.push(p);
        const lrc = textToLrc(script, cursor);
        lrcParts.push(lrc.lrc);
        cursor = lrc.endSeconds + 0.5;
      }
    }

    // ── Combine all audio (simple mode) ─────────────────────────────────────
    const id = randomUUID();
    const audioPath = path.join(audioDir, `${id}.mp3`);
    const lrcPath = path.join(lrcDir, `${id}.lrc`);

    if (ffmpeg && audioFiles.length > 0) {
      console.log(`[pipeline] ffmpeg concat of ${audioFiles.length} segments → ${audioPath}`);
      await ffmpegConcat(ffmpeg, audioFiles, audioPath);
    } else if (audioFiles.length > 0) {
      console.log("[pipeline] raw buffer concat fallback");
      const buffers = await Promise.all(audioFiles.map((f) => fs.readFile(f)));
      await fs.writeFile(audioPath, Buffer.concat(buffers));
    } else {
      throw new Error("No audio segments generated");
    }

    await fs.writeFile(lrcPath, lrcParts.filter(Boolean).join("\n"));
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

    const today = new Date().toISOString().slice(0, 10);
    const title = opts.title ?? (isSummary ? "BriefCast Summary" : articles[0]?.title ?? `BriefCast – ${today}`);

    console.log(`[pipeline] done (simple mode) — duration:${Math.round(cursor)}s audio:${audioPath}`);
    return { id, title, audioPath, lrcPath, durationSeconds: Math.round(cursor), publishedAt: Date.now() };
  }

  // ── Full pipeline with intro/outro (daily briefing) ───────────────────────

  // ── Load all resource audio ───────────────────────────────────────────────
  const [opWav, openingWav, startingWav, endingWav, edWav] = await Promise.all([
    resourceAudio("op.wav"),
    resourceAudio("opening.wav"),
    resourceAudio("starting.wav"),
    resourceAudio("ending.wav"),
    resourceAudio("ed.wav"),
  ]);
  const [openingLrcRaw, startingLrcRaw, endingLrcRaw] = await Promise.all([
    resourceText("opening.lrc"),
    resourceText("starting.lrc"),
    resourceText("ending.lrc"),
  ]);

  const openingDur = openingWav ? wavDurationSeconds(openingWav) : 0;
  const startingDur = startingWav ? wavDurationSeconds(startingWav) : 0;
  const endingDur = endingWav ? wavDurationSeconds(endingWav) : 0;
  console.log(`[pipeline] resource durations — opening:${openingDur.toFixed(1)}s starting:${startingDur.toFixed(1)}s ending:${endingDur.toFixed(1)}s`);

  // ── Opening: background music (op.wav) mixed with greeting + weather + bookends ──
  const canUseBgMix = ffmpeg && opWav;
  const SPEECH_DELAY_S = 31; // seconds before speech starts (background music intro)

  if (canUseBgMix) {
    // Write op.wav to tmp
    const opPath = path.join(tmpDir, "op.wav");
    await fs.writeFile(opPath, opWav!);
    tempFiles.push(opPath);

    // Speech segments to mix over the background (in order)
    const openingSpeechFiles: string[] = [];
    let speechCursor = SPEECH_DELAY_S; // LRC cursor starts after the 31s delay

    // 1. Greeting TTS: "Good morning! Today is X."
    const now = new Date();
    const greetingText = `${getGreeting(now.getHours())}! Today is ${formatDateLong(now)}.`;
    console.log("[pipeline] synthesising greeting…");
    try {
      const greetAudio = await synthesizeSpeech(settings, greetingText);
      const ext = greetAudio.mimeType.includes("aiff") ? "aiff" : "mp3";
      const gp = path.join(tmpDir, `greeting.${ext}`);
      await fs.writeFile(gp, greetAudio.buffer);
      tempFiles.push(gp);
      openingSpeechFiles.push(gp);
      const greetLrc = textToLrc(greetingText, speechCursor);
      lrcParts.push(greetLrc.lrc);
      speechCursor = greetLrc.endSeconds + 0.5;
    } catch (e) {
      console.warn("[pipeline] greeting TTS failed:", e);
    }

    // 2. opening.wav (host recorded intro)
    if (openingWav) {
      const op = path.join(tmpDir, "opening.wav");
      await fs.writeFile(op, openingWav);
      tempFiles.push(op);
      openingSpeechFiles.push(op);
      if (openingLrcRaw) lrcParts.push(offsetLrc(openingLrcRaw.trim(), speechCursor));
      speechCursor += openingDur;
    }

    // 3. Weather forecast TTS (optional, requires location)
    if (location) {
      console.log("[pipeline] fetching weather for", location);
      const rawWeather = await fetchWeatherData(location);
      if (rawWeather) {
        const weatherScript = await buildWeatherScript(settings, rawWeather);
        if (weatherScript) {
          console.log("[pipeline] synthesising weather forecast…");
          try {
            const wAudio = await synthesizeSpeech(settings, weatherScript);
            const ext = wAudio.mimeType.includes("aiff") ? "aiff" : "mp3";
            const wp = path.join(tmpDir, `weather.${ext}`);
            await fs.writeFile(wp, wAudio.buffer);
            tempFiles.push(wp);
            openingSpeechFiles.push(wp);
            const wLrc = textToLrc(weatherScript, speechCursor);
            lrcParts.push(wLrc.lrc);
            speechCursor = wLrc.endSeconds + 0.5;
          } catch (e) {
            console.warn("[pipeline] weather TTS failed:", e);
          }
        }
      }
    }

    // 4. starting.wav (host recorded "starting" segment)
    if (startingWav) {
      const sp = path.join(tmpDir, "starting.wav");
      await fs.writeFile(sp, startingWav);
      tempFiles.push(sp);
      openingSpeechFiles.push(sp);
      if (startingLrcRaw) lrcParts.push(offsetLrc(startingLrcRaw.trim(), speechCursor));
      speechCursor += startingDur;
    }

    // Mix op.wav background + speech, speech delayed 31s
    const openingMixedPath = path.join(tmpDir, "opening_mixed.mp3");
    console.log(`[pipeline] mixing opening: op.wav + ${openingSpeechFiles.length} speech segments (delay:${SPEECH_DELAY_S}s)…`);
    try {
      await ffmpegMixWithBg(ffmpeg!, opPath, openingSpeechFiles, 0.35, SPEECH_DELAY_S * 1000, openingMixedPath);
      tempFiles.push(openingMixedPath);
      audioFiles.push(openingMixedPath);
      // The mixed file duration = max(op.wav, SPEECH_DELAY_S + speech_duration)
      // Use speechCursor as the content cursor going forward
      cursor = speechCursor + 0.5;
    } catch (e) {
      console.warn("[pipeline] opening mix failed, falling back to concat:", e);
      // Fallback: just add speech files directly
      for (const f of openingSpeechFiles) audioFiles.push(f);
      cursor = speechCursor + 0.5;
    }
  } else if (ffmpeg && (openingWav || startingWav)) {
    // No op.wav but ffmpeg available — use resource WAVs directly
    if (openingWav) {
      const p = path.join(tmpDir, "opening.wav");
      await fs.writeFile(p, openingWav);
      tempFiles.push(p);
      audioFiles.push(p);
      if (openingLrcRaw) lrcParts.push(offsetLrc(openingLrcRaw.trim(), cursor));
      cursor += openingDur;
    }
    if (startingWav) {
      const p = path.join(tmpDir, "starting.wav");
      await fs.writeFile(p, startingWav);
      tempFiles.push(p);
      audioFiles.push(p);
      if (startingLrcRaw) lrcParts.push(offsetLrc(startingLrcRaw.trim(), cursor));
      cursor += startingDur;
    }
  } else {
    // No ffmpeg or no resource audio — synthesise a simple greeting + optional weather
    const now = new Date();
    const greetingText = `${getGreeting(now.getHours())}! Today is ${formatDateLong(now)}. ${
      isSummary ? "Here is your personalized news summary." : "Here are your top stories from around the world."
    } Now, let's move into today's news.`;
    console.log("[pipeline] synthesising fallback greeting…");
    try {
      const greetAudio = await synthesizeSpeech(settings, greetingText);
      const p = path.join(tmpDir, `greeting.${greetAudio.mimeType.includes("aiff") ? "aiff" : "mp3"}`);
      await fs.writeFile(p, greetAudio.buffer);
      tempFiles.push(p);
      audioFiles.push(p);
      const greetLrc = textToLrc(greetingText, cursor);
      lrcParts.push(greetLrc.lrc);
      cursor = greetLrc.endSeconds + 1;
    } catch (e) {
      console.warn("[pipeline] fallback greeting TTS failed:", e);
    }

    // Weather forecast (no ffmpeg mix — append as a separate segment)
    if (location) {
      console.log("[pipeline] fetching weather for", location);
      const rawWeather = await fetchWeatherData(location);
      if (rawWeather) {
        const weatherScript = await buildWeatherScript(settings, rawWeather);
        if (weatherScript) {
          console.log("[pipeline] synthesising weather forecast…");
          try {
            const wAudio = await synthesizeSpeech(settings, weatherScript);
            const ext = wAudio.mimeType.includes("aiff") ? "aiff" : "mp3";
            const wp = path.join(tmpDir, `weather.${ext}`);
            await fs.writeFile(wp, wAudio.buffer);
            tempFiles.push(wp);
            audioFiles.push(wp);
            const wLrc = textToLrc(weatherScript, cursor);
            lrcParts.push(wLrc.lrc);
            cursor = wLrc.endSeconds + 0.5;
          } catch (e) {
            console.warn("[pipeline] weather TTS failed:", e);
          }
        }
      }
    }
  }

  // ── Content: stories or summary ───────────────────────────────────────────
  if (isSummary) {
    let script: string;
    try {
      script = await buildSummaryScript(settings, articles);
    } catch {
      script = articles.map((a) => `${a.title}. ${a.summary || ""}`).join(" Next, ");
    }
    const audio = await synthesizeSpeech(settings, script);
    const ext = audio.mimeType.includes("aiff") ? "aiff" : "mp3";
    const p = path.join(tmpDir, `summary.${ext}`);
    await fs.writeFile(p, audio.buffer);
    tempFiles.push(p);
    audioFiles.push(p);
    const lrc = textToLrc(script, cursor);
    lrcParts.push(lrc.lrc);
    cursor = lrc.endSeconds + 1;
  } else {
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      let script: string;
      console.log(`[pipeline] story ${i + 1}/${articles.length}: "${article.title.slice(0, 60)}"`);
      try {
        script = await buildStoryScript(settings, article);
      } catch (err) {
        console.warn(`[pipeline] buildStoryScript failed:`, err);
        script = `${article.title}. ${article.summary || "More details available online."}`;
      }

      console.log(`[pipeline] synthesising story ${i + 1}…`);
      const audio = await synthesizeSpeech(settings, script);
      const ext = audio.mimeType.includes("aiff") ? "aiff" : "mp3";
      const p = path.join(tmpDir, `story_${i}.${ext}`);
      await fs.writeFile(p, audio.buffer);
      tempFiles.push(p);
      audioFiles.push(p);
      const lrc = textToLrc(script, cursor);
      lrcParts.push(lrc.lrc);
      cursor = lrc.endSeconds + 1;

      // Transition to next story
      if (i < articles.length - 1) {
        const transText = await buildTransition(settings, article.title, articles[i + 1].title);
        const transAudio = await synthesizeSpeech(settings, transText);
        const transExt = transAudio.mimeType.includes("aiff") ? "aiff" : "mp3";
        const tp = path.join(tmpDir, `trans_${i}.${transExt}`);
        await fs.writeFile(tp, transAudio.buffer);
        tempFiles.push(tp);
        audioFiles.push(tp);
        const tLrc = textToLrc(transText, cursor);
        lrcParts.push(tLrc.lrc);
        cursor = tLrc.endSeconds + 1;
      }
    }
  }

  // ── Ending: ed.wav background mixed with ending.wav speech ───────────────
  const ENDING_DELAY_S = 3.5;

  if (ffmpeg && edWav && endingWav) {
    const edPath = path.join(tmpDir, "ed.wav");
    await fs.writeFile(edPath, edWav);
    tempFiles.push(edPath);

    const endSpeechPath = path.join(tmpDir, "ending_speech.wav");
    await fs.writeFile(endSpeechPath, endingWav);
    tempFiles.push(endSpeechPath);

    const endingMixedPath = path.join(tmpDir, "ending_mixed.mp3");
    console.log(`[pipeline] mixing ending: ed.wav + ending.wav (delay:${ENDING_DELAY_S}s)…`);
    try {
      await ffmpegMixWithBg(ffmpeg!, edPath, [endSpeechPath], 0.35, ENDING_DELAY_S * 1000, endingMixedPath);
      tempFiles.push(endingMixedPath);
      audioFiles.push(endingMixedPath);
      if (endingLrcRaw) lrcParts.push(offsetLrc(endingLrcRaw.trim(), cursor + ENDING_DELAY_S));
      cursor += ENDING_DELAY_S + endingDur + 2;
    } catch (e) {
      console.warn("[pipeline] ending mix failed, using ending.wav directly:", e);
      audioFiles.push(endSpeechPath);
      if (endingLrcRaw) lrcParts.push(offsetLrc(endingLrcRaw.trim(), cursor));
      cursor += endingDur;
    }
  } else if (ffmpeg && endingWav) {
    // No ed.wav but we have ending.wav
    const p = path.join(tmpDir, "ending.wav");
    await fs.writeFile(p, endingWav);
    tempFiles.push(p);
    audioFiles.push(p);
    if (endingLrcRaw) lrcParts.push(offsetLrc(endingLrcRaw.trim(), cursor));
    cursor += endingDur;
  } else if (!ffmpeg) {
    const now = new Date();
    const endingText = `That's all for ${isSummary ? "your summary" : "today's briefing"}. Stay informed and have a wonderful ${getDayPart(now.getHours())}.`;
    const endingAudio = await synthesizeSpeech(settings, endingText);
    const ext = endingAudio.mimeType.includes("aiff") ? "aiff" : "mp3";
    const p = path.join(tmpDir, `ending.${ext}`);
    await fs.writeFile(p, endingAudio.buffer);
    tempFiles.push(p);
    audioFiles.push(p);
    const lrc = textToLrc(endingText, cursor);
    lrcParts.push(lrc.lrc);
    cursor = lrc.endSeconds;
  }

  // ── Combine all audio ─────────────────────────────────────────────────────
  const id = randomUUID();
  const audioPath = path.join(audioDir, `${id}.mp3`);
  const lrcPath = path.join(lrcDir, `${id}.lrc`);

  if (ffmpeg && audioFiles.length > 0) {
    console.log(`[pipeline] ffmpeg concat of ${audioFiles.length} segments → ${audioPath}`);
    await ffmpegConcat(ffmpeg, audioFiles, audioPath);
  } else {
    console.log("[pipeline] raw buffer concat fallback");
    const buffers = await Promise.all(audioFiles.map((f) => fs.readFile(f)));
    await fs.writeFile(audioPath, Buffer.concat(buffers));
  }

  await fs.writeFile(lrcPath, lrcParts.filter(Boolean).join("\n"));

  // Cleanup temp files
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  const today = new Date().toISOString().slice(0, 10);
  const title = opts.title ?? (isSummary ? "BriefCast Summary" : `BriefCast Daily – ${today}`);

  console.log(`[pipeline] done — duration:${Math.round(cursor)}s audio:${audioPath}`);
  return { id, title, audioPath, lrcPath, durationSeconds: Math.round(cursor), publishedAt: Date.now() };
}
