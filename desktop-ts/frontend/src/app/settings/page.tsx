"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import axios from "axios";
import { getBackendBase } from "@/utils/backendUrl";

const BASE = getBackendBase();

interface AppSettings {
  providers: {
    activeProvider: "openai-compatible" | "anthropic" | "codex-cli" | "claude-cli";
    openaiCompatible: { baseUrl: string; apiKey: string; model: string; embeddingModel: string };
    anthropic: { apiKey: string; model: string };
    codexCli: { command: string; argsTemplate: string };
    claudeCli: { command: string; argsTemplate: string };
  };
  tts: { provider: "openai-compatible" | "system-say"; voice: string; model: string; systemVoice: string };
  sources: {
    rssEnabled: boolean; rssFeeds: string[];
    hackerNewsEnabled: boolean;
    redditEnabled: boolean; redditSubreddits: string[];
    devToEnabled: boolean; devToTags: string[];
    lobstersEnabled: boolean;
    googleNewsEnabled: boolean; googleNewsTopics: string[];
    githubTrendingEnabled: boolean;
    slashdotEnabled: boolean;
    productHuntEnabled: boolean;
  };
  preferences: { topics: string[]; region: string; language: string; dailyBriefingCount: number };
}

const DEFAULTS: AppSettings = {
  providers: {
    activeProvider: "openai-compatible",
    openaiCompatible: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4.1-mini", embeddingModel: "text-embedding-3-small" },
    anthropic: { apiKey: "", model: "claude-3-5-sonnet-latest" },
    codexCli: { command: "codex", argsTemplate: "" },
    claudeCli: { command: "claude", argsTemplate: "" },
  },
  tts: { provider: "openai-compatible", voice: "alloy", model: "gpt-4o-mini-tts", systemVoice: "Samantha" },
  sources: {
    rssEnabled: true, rssFeeds: [],
    hackerNewsEnabled: true,
    redditEnabled: false, redditSubreddits: [],
    devToEnabled: false, devToTags: [],
    lobstersEnabled: false,
    googleNewsEnabled: false, googleNewsTopics: [],
    githubTrendingEnabled: false,
    slashdotEnabled: false,
    productHuntEnabled: false,
  },
  preferences: { topics: [], region: "US", language: "en", dailyBriefingCount: 5 },
};

const inp = "w-full px-3 py-2 text-sm bg-white/10 border border-white/20 rounded-md text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-amber-500";
const lbl = "block text-white/80 text-xs font-medium mb-1";
const card = "bg-white/10 backdrop-blur-md rounded-xl p-5 shadow-xl space-y-3";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const { data } = await axios.get<AppSettings>(`${BASE}api/settings`, {
        params: { _ts: Date.now() },
        headers: { "Cache-Control": "no-cache" }
      });
      setSettings({ ...DEFAULTS, ...data });
    } catch {}
    if (!quiet) setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Hotload: refetch when tab regains focus
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load(true);
    };
    const onFocus = () => load(true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await axios.post<AppSettings>(`${BASE}api/settings`, settings);
      setSettings({ ...DEFAULTS, ...data });
      setMsg({ text: "Settings saved!", ok: true });
    } catch (err: any) {
      setMsg({ text: err.response?.data?.error ?? "Save failed", ok: false });
    }
    setSaving(false);
    setTimeout(() => setMsg(null), 3000);
  };

  const setP = (k: string, v: unknown) =>
    setSettings((s) => ({ ...s, providers: { ...s.providers, [k]: v } }));
  const setSrc = (k: string, v: unknown) =>
    setSettings((s) => ({ ...s, sources: { ...s.sources, [k]: v } }));

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 to-purple-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-400" />
      </div>
    );
  }

  return (
     <div className={`min-h-screen bg-gradient-to-br from-indigo-900/90 to-purple-900/90 text-white`}>
      <header className="bg-white/10 backdrop-blur-md shadow-lg">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            {/* <Link href="/" className="text-2xl font-bold text-white">BriefCast</Link> */}
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/" className="text-white/80 hover:text-white">Player</Link>
            <Link href="/library" className="text-white/80 hover:text-white">Library</Link>
            <Link href="/downloads" className="text-white/80 hover:text-white">Downloads</Link>
            <Link href="/history" className="text-white/80 hover:text-white">History</Link>
            <Link href="/settings" className="text-amber-400 font-medium">Settings</Link>
            {/* <Link href="/dashboard" className="text-white/70 hover:text-white">Dashboard</Link> */}
          </nav>
        </div>
      </header>

      <main className="container max-w-2xl mx-auto px-4 py-8 space-y-5">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-white/60 text-sm mt-1">Configure providers, TTS, sources and preferences</p>
        </div>

        {/* AI Provider */}
        <div className={card}>
          <h2 className="text-base font-semibold flex items-center gap-2">🤖 AI Provider</h2>
          <div>
            <label className={lbl}>Active Provider</label>
            <select className={inp} value={settings.providers.activeProvider}
              onChange={(e) => setP("activeProvider", e.target.value)}>
              <option value="openai-compatible" className="bg-gray-800">OpenAI Compatible</option>
              <option value="anthropic" className="bg-gray-800">Anthropic</option>
              <option value="codex-cli" className="bg-gray-800">Codex CLI</option>
              <option value="claude-cli" className="bg-gray-800">Claude CLI</option>
            </select>
          </div>

          {settings.providers.activeProvider === "openai-compatible" && (
            <div className="space-y-3 pt-2 border-t border-white/10">
              <div><label className={lbl}>API Base URL</label>
                <input className={inp} value={settings.providers.openaiCompatible.baseUrl}
                  onChange={(e) => setP("openaiCompatible", { ...settings.providers.openaiCompatible, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1" /></div>
              <div><label className={lbl}>API Key</label>
                <input className={inp} type="password" value={settings.providers.openaiCompatible.apiKey}
                  onChange={(e) => setP("openaiCompatible", { ...settings.providers.openaiCompatible, apiKey: e.target.value })}
                  placeholder="sk-…" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={lbl}>Chat Model</label>
                  <input className={inp} value={settings.providers.openaiCompatible.model}
                    onChange={(e) => setP("openaiCompatible", { ...settings.providers.openaiCompatible, model: e.target.value })}
                    placeholder="gpt-4.1-mini" /></div>
                <div><label className={lbl}>Embedding Model</label>
                  <input className={inp} value={settings.providers.openaiCompatible.embeddingModel}
                    onChange={(e) => setP("openaiCompatible", { ...settings.providers.openaiCompatible, embeddingModel: e.target.value })}
                    placeholder="text-embedding-3-small" /></div>
              </div>
            </div>
          )}

          {settings.providers.activeProvider === "anthropic" && (
            <div className="space-y-3 pt-2 border-t border-white/10">
              <div><label className={lbl}>API Key</label>
                <input className={inp} type="password" value={settings.providers.anthropic.apiKey}
                  onChange={(e) => setP("anthropic", { ...settings.providers.anthropic, apiKey: e.target.value })}
                  placeholder="sk-ant-…" /></div>
              <div><label className={lbl}>Model</label>
                <input className={inp} value={settings.providers.anthropic.model}
                  onChange={(e) => setP("anthropic", { ...settings.providers.anthropic, model: e.target.value })}
                  placeholder="claude-3-5-sonnet-latest" /></div>
            </div>
          )}

          {settings.providers.activeProvider === "codex-cli" && (
            <div className="space-y-3 pt-2 border-t border-white/10">
              <div><label className={lbl}>Command</label>
                <input className={inp} value={settings.providers.codexCli.command}
                  onChange={(e) => setP("codexCli", { ...settings.providers.codexCli, command: e.target.value })}
                  placeholder="codex" /></div>
              <div><label className={lbl}>Args Template</label>
                <input className={inp} value={settings.providers.codexCli.argsTemplate}
                  onChange={(e) => setP("codexCli", { ...settings.providers.codexCli, argsTemplate: e.target.value })}
                  placeholder="-q {{prompt}}" /></div>
            </div>
          )}

          {settings.providers.activeProvider === "claude-cli" && (
            <div className="space-y-3 pt-2 border-t border-white/10">
              <div><label className={lbl}>Command</label>
                <input className={inp} value={settings.providers.claudeCli.command}
                  onChange={(e) => setP("claudeCli", { ...settings.providers.claudeCli, command: e.target.value })}
                  placeholder="claude" /></div>
              <div><label className={lbl}>Args Template</label>
                <input className={inp} value={settings.providers.claudeCli.argsTemplate}
                  onChange={(e) => setP("claudeCli", { ...settings.providers.claudeCli, argsTemplate: e.target.value })}
                  placeholder="-p {{prompt}}" /></div>
            </div>
          )}
        </div>

        {/* TTS */}
        <div className={card}>
          <h2 className="text-base font-semibold flex items-center gap-2">🔊 Text-to-Speech</h2>
          <div>
            <label className={lbl}>Provider</label>
            <select className={inp} value={settings.tts.provider}
              onChange={(e) => setSettings((s) => ({ ...s, tts: { ...s.tts, provider: e.target.value as "openai-compatible" | "system-say" } }))}>
              <option value="openai-compatible" className="bg-gray-800">OpenAI Compatible</option>
              <option value="system-say" className="bg-gray-800">System Say (macOS)</option>
            </select>
          </div>
          {settings.tts.provider === "openai-compatible" && (
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/10">
              <div><label className={lbl}>Voice</label>
                <input className={inp} value={settings.tts.voice}
                  onChange={(e) => setSettings((s) => ({ ...s, tts: { ...s.tts, voice: e.target.value } }))}
                  placeholder="alloy" /></div>
              <div><label className={lbl}>Model</label>
                <input className={inp} value={settings.tts.model}
                  onChange={(e) => setSettings((s) => ({ ...s, tts: { ...s.tts, model: e.target.value } }))}
                  placeholder="gpt-4o-mini-tts" /></div>
            </div>
          )}
          {settings.tts.provider === "system-say" && (
            <div className="pt-2 border-t border-white/10">
              <label className={lbl}>System Voice</label>
              <input className={inp} value={settings.tts.systemVoice}
                onChange={(e) => setSettings((s) => ({ ...s, tts: { ...s.tts, systemVoice: e.target.value } }))}
                placeholder="Samantha" />
            </div>
          )}
        </div>

        {/* Preferences */}
        <div className={card}>
          <h2 className="text-base font-semibold flex items-center gap-2">🎯 Preferences</h2>
          <div>
            <label className={lbl}>Topics <span className="text-white/40 font-normal">(comma-separated)</span></label>
            <input className={inp}
              value={settings.preferences.topics.join(", ")}
              onChange={(e) => setSettings((s) => ({ ...s, preferences: { ...s.preferences, topics: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) } }))}
              placeholder="technology, business, science" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={lbl}>Region</label>
              <input className={inp} value={settings.preferences.region}
                onChange={(e) => setSettings((s) => ({ ...s, preferences: { ...s.preferences, region: e.target.value } }))}
                placeholder="US" /></div>
            <div><label className={lbl}>Language</label>
              <input className={inp} value={settings.preferences.language}
                onChange={(e) => setSettings((s) => ({ ...s, preferences: { ...s.preferences, language: e.target.value } }))}
                placeholder="en" /></div>
          </div>
          <div>
            <label className={lbl}>Daily briefing story count</label>
            <input
              className={inp}
              type="number"
              min={1}
              max={20}
              value={settings.preferences.dailyBriefingCount}
              onChange={(e) => {
                const n = Number(e.target.value);
                setSettings((s) => ({
                  ...s,
                  preferences: {
                    ...s.preferences,
                    dailyBriefingCount: Number.isFinite(n) ? Math.max(1, Math.min(20, Math.floor(n))) : 5
                  }
                }));
              }}
            />
          </div>
        </div>

        {/* News Sources */}
        <div className={card}>
          <h2 className="text-base font-semibold flex items-center gap-2">📰 News Sources</h2>
          <div className="space-y-2">
            {([
              { k: "hackerNewsEnabled", label: "Hacker News" },
              { k: "lobstersEnabled", label: "Lobsters" },
              { k: "githubTrendingEnabled", label: "GitHub Trending" },
              { k: "slashdotEnabled", label: "Slashdot" },
              { k: "productHuntEnabled", label: "Product Hunt" },
            ] as { k: keyof AppSettings["sources"]; label: string }[]).map(({ k, label }) => (
              <label key={k} className="flex items-center justify-between cursor-pointer">
                <span className="text-white/80 text-sm">{label}</span>
                <input type="checkbox" checked={settings.sources[k] as boolean}
                  onChange={(e) => setSrc(k, e.target.checked)} className="w-4 h-4 accent-amber-500" />
              </label>
            ))}
          </div>

          {/* Reddit */}
          <div className="pt-3 border-t border-white/10 space-y-2">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-white/80 text-sm font-medium">Reddit</span>
              <input type="checkbox" checked={settings.sources.redditEnabled}
                onChange={(e) => setSrc("redditEnabled", e.target.checked)} className="w-4 h-4 accent-amber-500" />
            </label>
            {settings.sources.redditEnabled && (
              <div><label className={lbl}>Subreddits <span className="text-white/40 font-normal">(comma-separated)</span></label>
                <input className={inp}
                  value={settings.sources.redditSubreddits.join(", ")}
                  onChange={(e) => setSrc("redditSubreddits", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
                  placeholder="technology, worldnews" /></div>
            )}
          </div>

          {/* Dev.to */}
          <div className="pt-3 border-t border-white/10 space-y-2">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-white/80 text-sm font-medium">Dev.to</span>
              <input type="checkbox" checked={settings.sources.devToEnabled}
                onChange={(e) => setSrc("devToEnabled", e.target.checked)} className="w-4 h-4 accent-amber-500" />
            </label>
            {settings.sources.devToEnabled && (
              <div><label className={lbl}>Tags <span className="text-white/40 font-normal">(comma-separated)</span></label>
                <input className={inp}
                  value={settings.sources.devToTags.join(", ")}
                  onChange={(e) => setSrc("devToTags", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
                  placeholder="javascript, webdev" /></div>
            )}
          </div>

          {/* Google News */}
          <div className="pt-3 border-t border-white/10 space-y-2">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-white/80 text-sm font-medium">Google News</span>
              <input type="checkbox" checked={settings.sources.googleNewsEnabled}
                onChange={(e) => setSrc("googleNewsEnabled", e.target.checked)} className="w-4 h-4 accent-amber-500" />
            </label>
            {settings.sources.googleNewsEnabled && (
              <div><label className={lbl}>Topics <span className="text-white/40 font-normal">(comma-separated)</span></label>
                <input className={inp}
                  value={settings.sources.googleNewsTopics.join(", ")}
                  onChange={(e) => setSrc("googleNewsTopics", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
                  placeholder="technology, business" /></div>
            )}
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center justify-between pb-8">
          {msg ? (
            <span className={`text-sm font-medium ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</span>
          ) : <span />}
          <div className="flex gap-3">
            <button onClick={() => load()} className="px-4 py-2 text-sm text-white/70 hover:text-white border border-white/20 rounded-lg transition-colors">
              Refresh
            </button>
            <button onClick={save} disabled={saving}
              className="px-6 py-2 text-sm font-semibold bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg transition-colors">
              {saving ? "Saving…" : "Save Settings"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
