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
          partial.providers?.activeProvider ??
          (process.env.BRIEFCAST_ACTIVE_PROVIDER as AppSettings["providers"]["activeProvider"] | undefined) ??
          DEFAULT_SETTINGS.providers.activeProvider,
        openaiCompatible: {
          ...DEFAULT_SETTINGS.providers.openaiCompatible,
          ...(partial.providers?.openaiCompatible ?? {}),
          baseUrl: partial.providers?.openaiCompatible?.baseUrl ?? process.env.BRIEFCAST_OPENAI_BASE_URL ?? DEFAULT_SETTINGS.providers.openaiCompatible.baseUrl,
          apiKey: partial.providers?.openaiCompatible?.apiKey ?? process.env.BRIEFCAST_OPENAI_API_KEY ?? DEFAULT_SETTINGS.providers.openaiCompatible.apiKey,
          model: partial.providers?.openaiCompatible?.model ?? process.env.BRIEFCAST_OPENAI_MODEL ?? DEFAULT_SETTINGS.providers.openaiCompatible.model,
          embeddingModel:
            partial.providers?.openaiCompatible?.embeddingModel ??
            process.env.BRIEFCAST_OPENAI_EMBEDDING_MODEL ??
            DEFAULT_SETTINGS.providers.openaiCompatible.embeddingModel
        },
        anthropic: {
          ...DEFAULT_SETTINGS.providers.anthropic,
          ...(partial.providers?.anthropic ?? {}),
          apiKey: partial.providers?.anthropic?.apiKey ?? process.env.BRIEFCAST_ANTHROPIC_API_KEY ?? DEFAULT_SETTINGS.providers.anthropic.apiKey,
          model: partial.providers?.anthropic?.model ?? process.env.BRIEFCAST_ANTHROPIC_MODEL ?? DEFAULT_SETTINGS.providers.anthropic.model
        },
        codexCli: {
          ...DEFAULT_SETTINGS.providers.codexCli,
          ...(partial.providers?.codexCli ?? {}),
          command: partial.providers?.codexCli?.command ?? process.env.BRIEFCAST_CODEX_COMMAND ?? DEFAULT_SETTINGS.providers.codexCli.command,
          argsTemplate:
            partial.providers?.codexCli?.argsTemplate ??
            process.env.BRIEFCAST_CODEX_ARGS_TEMPLATE ??
            DEFAULT_SETTINGS.providers.codexCli.argsTemplate
        },
        claudeCli: {
          ...DEFAULT_SETTINGS.providers.claudeCli,
          ...(partial.providers?.claudeCli ?? {}),
          command: partial.providers?.claudeCli?.command ?? process.env.BRIEFCAST_CLAUDE_COMMAND ?? DEFAULT_SETTINGS.providers.claudeCli.command,
          argsTemplate:
            partial.providers?.claudeCli?.argsTemplate ??
            process.env.BRIEFCAST_CLAUDE_ARGS_TEMPLATE ??
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
        ...partial.preferences,
        dailyBriefingCount: Math.max(
          1,
          Math.min(
            20,
            Math.floor(
              Number(partial.preferences?.dailyBriefingCount ?? DEFAULT_SETTINGS.preferences.dailyBriefingCount) ||
              DEFAULT_SETTINGS.preferences.dailyBriefingCount
            )
          )
        )
      },
      tts: {
        ...DEFAULT_SETTINGS.tts,
        ...(partial.tts ?? {}),
        provider:
          partial.tts?.provider ??
          (process.env.BRIEFCAST_TTS_PROVIDER as AppSettings["tts"]["provider"] | undefined) ??
          DEFAULT_SETTINGS.tts.provider,
        voice: partial.tts?.voice ?? process.env.BRIEFCAST_TTS_VOICE ?? DEFAULT_SETTINGS.tts.voice,
        model: partial.tts?.model ?? process.env.BRIEFCAST_TTS_MODEL ?? DEFAULT_SETTINGS.tts.model,
        systemVoice: partial.tts?.systemVoice ?? process.env.BRIEFCAST_TTS_SYSTEM_VOICE ?? DEFAULT_SETTINGS.tts.systemVoice,
        hostVoice: partial.tts?.hostVoice ?? process.env.BRIEFCAST_TTS_HOST_VOICE ?? DEFAULT_SETTINGS.tts.hostVoice
      }
    };
  }
}
