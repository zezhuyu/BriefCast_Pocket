import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppSettings, ProviderType } from "../../shared/types";
import { localEmbedText } from "./embeddings";

const DEFAULT_SYSTEM_PROMPT =
  "You are a concise daily news editor. Create clear, factual summaries, avoid hype, and preserve key details.";

// Track CLI provider rate-limit expiry (module-level, survives across calls in the same session)
const cliRateLimitedUntil: Record<string, number> = {};

export function getProviderStatus(): { rateLimited: boolean; provider: string; until?: number } {
  const entries = Object.entries(cliRateLimitedUntil).filter(([, until]) => Date.now() < until);
  if (entries.length > 0) {
    const [provider, until] = entries[0];
    return { rateLimited: true, provider, until };
  }
  return { rateLimited: false, provider: "ok" };
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function shellLikeSplit(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }

    if (quote && ch === quote) {
      quote = null;
      continue;
    }

    if (!quote && /\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function runCliCommand(command: string, argsTemplate: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts = shellLikeSplit(argsTemplate.trim());
    const hasPlaceholder = parts.some((part) => part.includes("{prompt}"));
    const args = parts.map((part) => part.replaceAll("{prompt}", prompt));

    const child = spawn(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to execute ${command}: ${err.message}`));
    });

    if (!hasPlaceholder) {
      child.stdin.write(prompt);
    }
    child.stdin.end();

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after 120s`));
    }, 120_000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const combined = (stderr + " " + stdout).toLowerCase();
        if (combined.includes("usage limit") || combined.includes("rate limit") || combined.includes("quota exceeded")) {
          // Rate-limited — suppress further calls for 2 hours
          const until = Date.now() + 2 * 60 * 60 * 1000;
          cliRateLimitedUntil[command] = until;
          const err = new Error(`CLI_RATE_LIMITED:${command}`);
          (err as any).rateLimited = true;
          reject(err);
          return;
        }
        reject(new Error(`${command} exited with code ${code}: ${stderr || "no stderr"}`));
        return;
      }

      const output = stdout.trim();
      if (!output) {
        reject(new Error(`${command} returned empty output`));
        return;
      }
      resolve(output);
    });
  });
}

async function callOpenAiCompatible(settings: AppSettings, prompt: string, systemPrompt?: string): Promise<string> {
  const config = settings.providers.openaiCompatible;
  if (!config.apiKey) {
    throw new Error("OpenAI-compatible API key is required");
  }

  const url = `${ensureTrailingSlash(config.baseUrl)}/chat/completions`;
  console.log("[providers] POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ]
    })
  });

  console.log("[providers] openai-compatible response status:", res.status);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI-compatible request failed: ${res.status} ${res.statusText} — ${body}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenAI-compatible response did not contain text");
  }

  return content;
}

async function callAnthropic(settings: AppSettings, prompt: string, systemPrompt?: string): Promise<string> {
  const config = settings.providers.anthropic;
  if (!config.apiKey) {
    throw new Error("Anthropic API key is required");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1400,
      system: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }]
    })
  });

  console.log("[providers] anthropic response status:", res.status);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic request failed: ${res.status} ${res.statusText} — ${body}`);
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const text = json.content?.find((item) => item.type === "text")?.text?.trim();
  if (!text) {
    throw new Error("Anthropic response did not contain text");
  }

  return text;
}

async function callCliProvider(
  settings: AppSettings,
  provider: Extract<ProviderType, "codex-cli" | "claude-cli">,
  prompt: string
): Promise<string> {
  const config = provider === "codex-cli" ? settings.providers.codexCli : settings.providers.claudeCli;
  return runCliCommand(config.command, config.argsTemplate, prompt);
}

export async function generateText(settings: AppSettings, prompt: string, systemPrompt?: string): Promise<string> {
  const provider = settings.providers.activeProvider;
  console.log("[providers] generateText via provider:", provider);

  if (provider === "openai-compatible") {
    const cfg = settings.providers.openaiCompatible;
    console.log("[providers] openai-compatible baseUrl:", cfg.baseUrl, "model:", cfg.model, "hasKey:", !!cfg.apiKey);
    return callOpenAiCompatible(settings, prompt, systemPrompt);
  }
  if (provider === "anthropic") {
    const cfg = settings.providers.anthropic;
    console.log("[providers] anthropic model:", cfg.model, "hasKey:", !!cfg.apiKey);
    return callAnthropic(settings, prompt, systemPrompt);
  }
  if (provider === "codex-cli" || provider === "claude-cli") {
    const cfg = provider === "codex-cli" ? settings.providers.codexCli : settings.providers.claudeCli;
    const until = cliRateLimitedUntil[cfg.command] ?? 0;
    if (Date.now() < until) {
      // Rate-limited — fall back to openai-compatible if configured
      const oai = settings.providers.openaiCompatible;
      if (oai.apiKey && oai.baseUrl) {
        console.warn(`[providers] ${provider} rate-limited, falling back to openai-compatible`);
        return callOpenAiCompatible(settings, prompt, systemPrompt);
      }
      throw new Error(`${provider} is rate-limited and no openai-compatible fallback is configured`);
    }
    console.log(`[providers] ${provider} command:`, cfg.command);
    try {
      return await callCliProvider(settings, provider, prompt);
    } catch (err) {
      if ((err as any).rateLimited) {
        const oai = settings.providers.openaiCompatible;
        if (oai.apiKey && oai.baseUrl) {
          console.warn(`[providers] ${provider} hit rate limit, switching to openai-compatible fallback`);
          return callOpenAiCompatible(settings, prompt, systemPrompt);
        }
      }
      throw err;
    }
  }

  throw new Error(`Unsupported provider: ${provider satisfies never}`);
}

export async function embedText(settings: AppSettings, text: string): Promise<number[]> {
  const provider = settings.providers.activeProvider;
  if (provider !== "openai-compatible") {
    return localEmbedText(text);
  }

  const config = settings.providers.openaiCompatible;
  if (!config.apiKey || !config.embeddingModel) {
    return localEmbedText(text);
  }

  try {
    const url = `${ensureTrailingSlash(config.baseUrl)}/embeddings`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: text
      })
    });

    if (!res.ok) {
      throw new Error("embedding request failed");
    }

    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };

    const vector = json.data?.[0]?.embedding;
    if (!vector?.length) {
      throw new Error("no embedding vector in response");
    }

    return vector;
  } catch {
    return localEmbedText(text);
  }
}

export async function synthesizeSpeech(settings: AppSettings, text: string): Promise<{ mimeType: string; buffer: Buffer }> {
  const textPreview = text.slice(0, 60).replace(/\n/g, " ");
  console.log(`[tts] synthesising (${settings.tts.provider}) "${textPreview}…"`);

  if (settings.tts.provider === "system-say") {
    const voice = settings.tts.systemVoice || "Samantha";
    console.log("[tts] using macOS say, voice:", voice);
    const outPath = path.join(os.tmpdir(), `briefcast-tts-${Date.now()}.aiff`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("say", ["-v", voice, "-o", outPath, text], {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => reject(new Error(`say command failed: ${err.message}`)));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`say exited with code ${code}: ${stderr || "no stderr"}`));
          return;
        }
        resolve();
      });
    });

    const buffer = await fs.readFile(outPath);
    await fs.unlink(outPath).catch(() => {});
    return {
      mimeType: "audio/aiff",
      buffer
    };
  }

  const config = settings.providers.openaiCompatible;
  if (!config.apiKey) {
    throw new Error("OpenAI-compatible API key is required for TTS synthesis");
  }

  const url = `${ensureTrailingSlash(config.baseUrl)}/audio/speech`;
  console.log("[tts] POST", url, "model:", settings.tts.model || "gpt-4o-mini-tts", "voice:", settings.tts.voice || "alloy");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: settings.tts.model || "gpt-4o-mini-tts",
      voice: settings.tts.voice || "alloy",
      input: text,
      format: "mp3"
    })
  });

  console.log("[tts] response status:", res.status);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TTS request failed: ${res.status} ${res.statusText} — ${body}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  console.log("[tts] audio received, bytes:", arrayBuffer.byteLength);
  return {
    mimeType: "audio/mpeg",
    buffer: Buffer.from(arrayBuffer)
  };
}
