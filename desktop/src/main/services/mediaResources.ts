import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  MediaManifest,
  MediaResourceFormat,
  MediaResourcePayload
} from "../../shared/types";

function resolveResourceDir(): string {
  if (process.env.BRIEFCAST_RESOURCE_DIR) {
    return process.env.BRIEFCAST_RESOURCE_DIR;
  }

  const candidates: string[] = [];

  // Packaged Electron app: extraResources land directly in process.resourcesPath
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "assets"));
  }

  // Dev mode: process.cwd() is the project root (desktop-ts/)
  candidates.push(path.resolve(process.cwd(), "assets"));

  // Compiled main.cjs lives in dist-electron/ → go up two levels to project root
  candidates.push(path.resolve(__dirname, "../../assets"));

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.resolve(process.cwd(), "assets");
}

const DEFAULT_RESOURCE_DIR = resolveResourceDir();

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".ogg"]);
const LYRIC_EXTENSIONS = new Set([".lrc", ".txt"]);
const IMAGE_DIR_NAME = "image";
const AUDIO_DIR_NAME = "audio";
const TRANSCRIPT_DIR_NAME = "transcript";

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Resource name is required");
  }

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (normalized.includes("../") || normalized.startsWith("/") || path.posix.basename(normalized) !== normalized) {
    throw new Error("Invalid resource name");
  }

  return normalized;
}

function mimeFromExt(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".lrc":
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function pickFirst(files: string[], preferred: string[]): string {
  for (const candidate of preferred) {
    if (files.includes(candidate)) {
      return candidate;
    }
  }
  return files[0] ?? "";
}

function resolveKindFromName(name: string): "image" | "audio" | "transcript" {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (LYRIC_EXTENSIONS.has(ext)) return "transcript";
  throw new Error(`Unsupported resource extension for "${name}"`);
}

export class MediaResourceService {
  private readonly resourceDir: string;

  constructor(resourceDir = DEFAULT_RESOURCE_DIR) {
    this.resourceDir = resourceDir;
  }

  async getManifest(): Promise<MediaManifest> {
    const images = await this.listFilesByKind("image");
    const audio = await this.listFilesByKind("audio");
    const lyrics = await this.listFilesByKind("transcript");

    return {
      resourceDir: this.resourceDir,
      images,
      audio,
      lyrics,
      defaults: {
        speakerImage: pickFirst(images, ["default.png", "host.png", "news.png"]),
        backgroundMusic: pickFirst(audio, ["starting.wav", "opening.wav", "op.wav"]),
        lyrics: pickFirst(lyrics, ["starting.lrc", "opening.lrc", "ending.lrc"])
      }
    };
  }

  async readResource(name: string, format: MediaResourceFormat = "base64"): Promise<MediaResourcePayload> {
    const normalized = normalizeName(name);
    const fullPath = this.resolveResourcePath(normalized);
    const content = await fs.readFile(fullPath);

    if (format === "text") {
      return {
        name: normalized,
        mimeType: mimeFromExt(normalized),
        format,
        content: content.toString("utf8")
      };
    }

    return {
      name: normalized,
      mimeType: mimeFromExt(normalized),
      format,
      content: content.toString("base64")
    };
  }

  async readResourceBuffer(name: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
    const normalized = normalizeName(name);
    const fullPath = this.resolveResourcePath(normalized);
    const buffer = await fs.readFile(fullPath);
    return {
      name: normalized,
      mimeType: mimeFromExt(normalized),
      buffer
    };
  }

  private resolveResourcePath(name: string): string {
    const kind = resolveKindFromName(name);
    switch (kind) {
      case "image":
        return path.join(this.resourceDir, IMAGE_DIR_NAME, name);
      case "audio":
        return path.join(this.resourceDir, AUDIO_DIR_NAME, name);
      case "transcript":
        return path.join(this.resourceDir, TRANSCRIPT_DIR_NAME, name);
    }
  }

  private async listFilesByKind(kind: "image" | "audio" | "transcript"): Promise<string[]> {
    const dirName =
      kind === "image"
        ? IMAGE_DIR_NAME
        : kind === "audio"
          ? AUDIO_DIR_NAME
          : TRANSCRIPT_DIR_NAME;
    const fullDir = path.join(this.resourceDir, dirName);

    try {
      const dirents = await fs.readdir(fullDir, { withFileTypes: true });
      return dirents
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${kind} resources at ${fullDir}: ${message}`);
    }
  }
}
