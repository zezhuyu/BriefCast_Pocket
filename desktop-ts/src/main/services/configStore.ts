import fs from "node:fs";
import path from "node:path";
import { AppSettings, DEFAULT_SETTINGS } from "../../shared/types";
import { loadRssFeedsFromCsv } from "./rssCatalog";

export class ConfigStore {
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, "settings.json");
  }

  load(): AppSettings {
    try {
      if (!fs.existsSync(this.filePath)) {
        const initial = this.mergeDefaults(DEFAULT_SETTINGS);
        this.save(initial);
        return initial;
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AppSettings;
      return this.mergeDefaults(parsed);
    } catch {
      const fallback = this.mergeDefaults(DEFAULT_SETTINGS);
      this.save(fallback);
      return fallback;
    }
  }

  save(settings: AppSettings): AppSettings {
    const normalized = this.mergeDefaults(settings);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }

  private mergeDefaults(partial: Partial<AppSettings>): AppSettings {
    const topicDefaults = partial.preferences?.topics ?? DEFAULT_SETTINGS.preferences.topics;
    const regionDefault = partial.preferences?.region ?? DEFAULT_SETTINGS.preferences.region;
    const csvFeeds = loadRssFeedsFromCsv(regionDefault, topicDefaults);

    const mergedFeeds = [
      ...(partial.sources?.rssFeeds ?? []),
      ...csvFeeds,
      ...DEFAULT_SETTINGS.sources.rssFeeds
    ];
    const dedupedFeeds = [...new Set(mergedFeeds.filter(Boolean))];

    return {
      providers: {
        ...DEFAULT_SETTINGS.providers,
        ...partial.providers,
        activeProvider:
          (process.env.BRIEFCAST_ACTIVE_PROVIDER as AppSettings["providers"]["activeProvider"] | undefined) ??
          partial.providers?.activeProvider ??
          DEFAULT_SETTINGS.providers.activeProvider,
        openaiCompatible: {
          ...DEFAULT_SETTINGS.providers.openaiCompatible,
          ...(partial.providers?.openaiCompatible ?? {}),
          baseUrl: process.env.BRIEFCAST_OPENAI_BASE_URL ?? partial.providers?.openaiCompatible?.baseUrl ?? DEFAULT_SETTINGS.providers.openaiCompatible.baseUrl,
          apiKey: process.env.BRIEFCAST_OPENAI_API_KEY ?? partial.providers?.openaiCompatible?.apiKey ?? DEFAULT_SETTINGS.providers.openaiCompatible.apiKey,
          model: process.env.BRIEFCAST_OPENAI_MODEL ?? partial.providers?.openaiCompatible?.model ?? DEFAULT_SETTINGS.providers.openaiCompatible.model,
          embeddingModel:
            process.env.BRIEFCAST_OPENAI_EMBEDDING_MODEL ??
            partial.providers?.openaiCompatible?.embeddingModel ??
            DEFAULT_SETTINGS.providers.openaiCompatible.embeddingModel
        },
        anthropic: {
          ...DEFAULT_SETTINGS.providers.anthropic,
          ...(partial.providers?.anthropic ?? {}),
          apiKey: process.env.BRIEFCAST_ANTHROPIC_API_KEY ?? partial.providers?.anthropic?.apiKey ?? DEFAULT_SETTINGS.providers.anthropic.apiKey,
          model: process.env.BRIEFCAST_ANTHROPIC_MODEL ?? partial.providers?.anthropic?.model ?? DEFAULT_SETTINGS.providers.anthropic.model
        },
        codexCli: {
          ...DEFAULT_SETTINGS.providers.codexCli,
          ...(partial.providers?.codexCli ?? {}),
          command: process.env.BRIEFCAST_CODEX_COMMAND ?? partial.providers?.codexCli?.command ?? DEFAULT_SETTINGS.providers.codexCli.command,
          argsTemplate:
            process.env.BRIEFCAST_CODEX_ARGS_TEMPLATE ??
            partial.providers?.codexCli?.argsTemplate ??
            DEFAULT_SETTINGS.providers.codexCli.argsTemplate
        },
        claudeCli: {
          ...DEFAULT_SETTINGS.providers.claudeCli,
          ...(partial.providers?.claudeCli ?? {}),
          command: process.env.BRIEFCAST_CLAUDE_COMMAND ?? partial.providers?.claudeCli?.command ?? DEFAULT_SETTINGS.providers.claudeCli.command,
          argsTemplate:
            process.env.BRIEFCAST_CLAUDE_ARGS_TEMPLATE ??
            partial.providers?.claudeCli?.argsTemplate ??
            DEFAULT_SETTINGS.providers.claudeCli.argsTemplate
        }
      },
      sources: {
        ...DEFAULT_SETTINGS.sources,
        ...partial.sources,
        rssFeeds: dedupedFeeds
      },
      preferences: {
        ...DEFAULT_SETTINGS.preferences,
        ...partial.preferences
      },
      tts: {
        ...DEFAULT_SETTINGS.tts,
        ...(partial.tts ?? {}),
        provider:
          (process.env.BRIEFCAST_TTS_PROVIDER as AppSettings["tts"]["provider"] | undefined) ??
          partial.tts?.provider ??
          DEFAULT_SETTINGS.tts.provider,
        voice: process.env.BRIEFCAST_TTS_VOICE ?? partial.tts?.voice ?? DEFAULT_SETTINGS.tts.voice,
        model: process.env.BRIEFCAST_TTS_MODEL ?? partial.tts?.model ?? DEFAULT_SETTINGS.tts.model,
        systemVoice: process.env.BRIEFCAST_TTS_SYSTEM_VOICE ?? partial.tts?.systemVoice ?? DEFAULT_SETTINGS.tts.systemVoice
      }
    };
  }
}
