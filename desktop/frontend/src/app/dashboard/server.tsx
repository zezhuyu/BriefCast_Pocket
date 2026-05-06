"use client";
import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { getBackendBase } from "@/utils/backendUrl";

const BASE = getBackendBase();

interface RSSLink {
  id: number;
  link: string;
}

interface RssFormData {
  link: string;
}

// ── AppSettings mirrors desktop-ts/src/shared/types.ts ────────────────────────
interface AppSettings {
  providers: {
    activeProvider: "openai-compatible" | "anthropic" | "codex-cli" | "claude-cli";
    openaiCompatible: { baseUrl: string; apiKey: string; model: string; embeddingModel: string };
    anthropic: { apiKey: string; model: string };
    codexCli: { command: string; argsTemplate: string };
    claudeCli: { command: string; argsTemplate: string };
  };
  tts: {
    provider: "openai-compatible" | "system-say";
    voice: string;
    model: string;
    systemVoice: string;
  };
  sources: {
    rssEnabled: boolean;
    rssFeeds: string[];
    hackerNewsEnabled: boolean;
    redditEnabled: boolean;
    redditSubreddits: string[];
    devToEnabled: boolean;
    devToTags: string[];
    lobstersEnabled: boolean;
    googleNewsEnabled: boolean;
    googleNewsTopics: string[];
    githubTrendingEnabled: boolean;
    slashdotEnabled: boolean;
    productHuntEnabled: boolean;
  };
  preferences: {
    topics: string[];
    region: string;
    language: string;
    dailyBriefingCount: number;
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  providers: {
    activeProvider: "openai-compatible",
    openaiCompatible: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4.1-mini", embeddingModel: "text-embedding-3-small" },
    anthropic: { apiKey: "", model: "claude-3-5-sonnet-latest" },
    codexCli: { command: "codex", argsTemplate: "" },
    claudeCli: { command: "claude", argsTemplate: "" },
  },
  tts: { provider: "openai-compatible", voice: "alloy", model: "gpt-4o-mini-tts", systemVoice: "Samantha" },
  sources: {
    rssEnabled: true,
    rssFeeds: [],
    hackerNewsEnabled: true,
    redditEnabled: false,
    redditSubreddits: [],
    devToEnabled: false,
    devToTags: [],
    lobstersEnabled: false,
    googleNewsEnabled: false,
    googleNewsTopics: [],
    githubTrendingEnabled: false,
    slashdotEnabled: false,
    productHuntEnabled: false,
  },
  preferences: { topics: [], region: "US", language: "en", dailyBriefingCount: 5 },
};

// ─────────────────────────────────────────────────────────────────────────────

export default function ServerConfigPage({ isTauri }: { isTauri: boolean }) {
  void isTauri;
  const [activeTab, setActiveTab] = useState<"rss" | "settings">("rss");

  // ── RSS state ────────────────────────────────────────────────────────────────
  const [rssLinks, setRssLinks] = useState<RSSLink[]>([]);
  const [rssLoading, setRssLoading] = useState(false);
  const [rssError, setRssError] = useState<string | null>(null);
  const [showRssForm, setShowRssForm] = useState(false);
  const [editingRssId, setEditingRssId] = useState<number | null>(null);
  const [rssFormData, setRssFormData] = useState<RssFormData>({ link: "" });
  const [rssFormError, setRssFormError] = useState("");
  const [actionLoading, setActionLoading] = useState<Set<number>>(new Set());
  const [forceRefreshing, setForceRefreshing] = useState(false);

  // ── Settings state ───────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // ── Fetch helpers ────────────────────────────────────────────────────────────
  const fetchSettings = useCallback(async (quiet = false) => {
    if (!quiet) setSettingsLoading(true);
    setSettingsError(null);
    try {
      const { data } = await axios.get<AppSettings>(`${BASE}api/settings`, {
        params: { _ts: Date.now() },
        headers: { "Cache-Control": "no-cache" }
      });
      setSettings({ ...DEFAULT_SETTINGS, ...data });
      return data;
    } catch (err: any) {
      if (!quiet) setSettingsError(err.response?.data?.error ?? "Failed to load settings");
    } finally {
      if (!quiet) setSettingsLoading(false);
    }
  }, []);

  const fetchRssLinks = useCallback(async () => {
    setRssLoading(true);
    setRssError(null);
    try {
      const { data } = await axios.get<AppSettings>(`${BASE}api/settings`);
      const feeds: string[] = data?.sources?.rssFeeds ?? [];
      setRssLinks(feeds.map((url, i) => ({ id: i, link: url })));
    } catch (err: any) {
      setRssError(err.response?.data?.error ?? "Failed to load RSS links");
    } finally {
      setRssLoading(false);
    }
  }, []);

  // ── Initial load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === "rss") fetchRssLinks();
    else fetchSettings();
  }, [activeTab, fetchRssLinks, fetchSettings]);

  // ── Hotload: refetch settings when tab regains focus ─────────────────────────
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && activeTab === "settings") {
        fetchSettings(true);
      }
    };
    const onFocus = () => {
      if (activeTab === "settings") fetchSettings(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeTab, fetchSettings]);

  // ── Settings save ─────────────────────────────────────────────────────────────
  const saveSettings = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const { data } = await axios.post<AppSettings>(`${BASE}api/settings`, settings);
      setSettings({ ...DEFAULT_SETTINGS, ...data });
      setSaveMsg({ text: "Settings saved!", ok: true });
    } catch (err: any) {
      setSaveMsg({ text: err.response?.data?.error ?? "Failed to save settings", ok: false });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 3000);
    }
  };

  // ── RSS CRUD ──────────────────────────────────────────────────────────────────
  const handleRssSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = rssFormData.link.trim();
    if (!url) { setRssFormError("URL is required"); return; }
    try { new URL(url); } catch { setRssFormError("Enter a valid URL"); return; }
    setRssFormError("");

    try {
      const { data } = await axios.get<AppSettings>(`${BASE}api/settings`);
      const feeds: string[] = data?.sources?.rssFeeds ?? [];
      if (editingRssId !== null) feeds[editingRssId] = url;
      else feeds.push(url);
      await axios.post(`${BASE}api/settings`, { ...data, sources: { ...data.sources, rssFeeds: feeds } });
      await fetchRssLinks();
      resetRssForm();
    } catch (err: any) {
      setRssFormError(err.response?.data?.error ?? "Failed to save feed");
    }
  };

  const handleRssDelete = async (id: number) => {
    if (!confirm("Delete this RSS feed?")) return;
    setActionLoading((s) => new Set(s).add(id));
    try {
      const { data } = await axios.get<AppSettings>(`${BASE}api/settings`);
      const feeds = (data?.sources?.rssFeeds ?? []).filter((_: string, i: number) => i !== id);
      await axios.post(`${BASE}api/settings`, { ...data, sources: { ...data.sources, rssFeeds: feeds } });
      await fetchRssLinks();
    } catch (err: any) {
      alert(err.response?.data?.error ?? "Failed to delete feed");
    } finally {
      setActionLoading((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const handleForceRefresh = async () => {
    setForceRefreshing(true);
    try { await axios.post(`${BASE}api/news/sync`); } catch {}
    setForceRefreshing(false);
  };

  const resetRssForm = () => {
    setRssFormData({ link: "" });
    setRssFormError("");
    setShowRssForm(false);
    setEditingRssId(null);
  };

  const startEditRss = (link: RSSLink) => {
    setEditingRssId(link.id);
    setRssFormData({ link: link.link });
    setShowRssForm(true);
  };

  // ── Settings helpers ──────────────────────────────────────────────────────────
  const setProvider = (key: string, value: unknown) =>
    setSettings((s) => ({ ...s, providers: { ...s.providers, [key]: value } }));
  const setTts = (key: string, value: string) =>
    setSettings((s) => ({ ...s, tts: { ...s.tts, [key]: value } }));
  const setSources = (key: string, value: unknown) =>
    setSettings((s) => ({ ...s, sources: { ...s.sources, [key]: value } }));

  // ── Shared style tokens ───────────────────────────────────────────────────────
  const inputCls = "w-full px-3 py-2 text-sm bg-white/10 border border-white/20 rounded-md text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent";
  const labelCls = "block text-white/80 text-xs font-medium mb-1";
  const sectionCls = "bg-white/10 backdrop-blur-md rounded-lg p-4 shadow-xl space-y-3";

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="w-full px-2 sm:px-4 py-4">
      {/* Header */}
      <div className="text-center mb-4">
        <h1 className="text-2xl font-bold text-white mb-1">Server Configuration</h1>
        <p className="text-white/70 text-sm">Manage RSS feeds and system settings</p>
      </div>

      {/* Tabs */}
      <div className="flex justify-center mb-4">
        <div className="bg-white/10 backdrop-blur-md rounded-lg p-1 flex space-x-1">
          {(["rss", "settings"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-4 py-2 text-sm rounded-md transition-colors ${
                activeTab === t
                  ? "bg-amber-500 text-white"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              {t === "rss" ? "RSS Feeds" : "Settings"}
            </button>
          ))}
        </div>
      </div>

      {/* ── RSS tab ──────────────────────────────────────────────────────────── */}
      {activeTab === "rss" && (
        <>
          {rssError && (
            <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4 text-red-200 text-sm">
              {rssError}
            </div>
          )}

          <div className="flex justify-between items-center mb-4">
            <span className="text-white/80 text-sm">
              Total: <span className="font-semibold text-amber-400">{rssLinks.length}</span>
            </span>
            <div className="flex space-x-2">
              <button
                onClick={handleForceRefresh}
                disabled={forceRefreshing}
                className="bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5"
              >
                <svg className={`w-3 h-3 ${forceRefreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>Force Sync</span>
              </button>
              <button
                onClick={fetchRssLinks}
                className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>Refresh</span>
              </button>
              <button
                onClick={() => setShowRssForm(true)}
                className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <span>Add Feed</span>
              </button>
            </div>
          </div>

          {showRssForm && (
            <div className="bg-white/10 backdrop-blur-md rounded-lg p-4 mb-4 shadow-xl">
              <h2 className="text-base font-bold text-white mb-3">
                {editingRssId !== null ? "Edit Feed" : "Add RSS Feed"}
              </h2>
              <form onSubmit={handleRssSubmit} className="space-y-3">
                {rssFormError && (
                  <p className="text-red-400 text-xs">{rssFormError}</p>
                )}
                <div>
                  <label className={labelCls}>Feed URL</label>
                  <input
                    type="url"
                    className={inputCls}
                    value={rssFormData.link}
                    onChange={(e) => setRssFormData({ link: e.target.value })}
                    placeholder="https://example.com/rss"
                    autoFocus
                  />
                </div>
                <div className="flex justify-end space-x-2">
                  <button type="button" onClick={resetRssForm} className="px-3 py-1.5 text-sm text-white/70 hover:text-white border border-white/20 rounded-md transition-colors">
                    Cancel
                  </button>
                  <button type="submit" className="bg-amber-500 hover:bg-amber-600 text-white px-4 py-1.5 text-sm rounded-md transition-colors">
                    {editingRssId !== null ? "Update" : "Add"}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="bg-white/10 backdrop-blur-md rounded-lg shadow-xl overflow-hidden">
            {rssLoading ? (
              <div className="flex justify-center items-center h-32">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-amber-400" />
              </div>
            ) : rssLinks.length === 0 ? (
              <div className="text-center py-12 text-white/60">
                <div className="text-3xl mb-2">📡</div>
                <p>No RSS feeds configured</p>
              </div>
            ) : (
              <div className="h-96 overflow-y-auto">
                <table className="w-full">
                  <thead className="bg-white/5 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-white/70 uppercase">Feed URL</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-white/70 uppercase w-24">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {rssLinks.map((link) => (
                      <tr key={link.id} className="hover:bg-white/5 transition-colors">
                        <td className="px-3 py-2 text-white text-sm font-mono truncate max-w-xs" title={link.link}>
                          {link.link}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex space-x-1">
                            <button
                              onClick={() => startEditRss(link)}
                              className="p-1 rounded text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 transition-colors"
                              title="Edit"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleRssDelete(link.id)}
                              disabled={actionLoading.has(link.id)}
                              className="p-1 rounded text-xs bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 disabled:opacity-50 transition-colors"
                              title="Delete"
                            >
                              {actionLoading.has(link.id) ? (
                                <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              ) : (
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Settings tab ─────────────────────────────────────────────────────── */}
      {activeTab === "settings" && (
        <>
          {settingsError && (
            <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4 text-red-200 text-sm flex items-center justify-between">
              <span>{settingsError}</span>
              <button onClick={() => fetchSettings()} className="underline text-xs">Retry</button>
            </div>
          )}

          {settingsLoading ? (
            <div className="flex justify-center items-center h-40">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-400" />
            </div>
          ) : (
            <div className="space-y-4 w-full">

              {/* AI Provider */}
              <div className={sectionCls}>
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <span>🤖</span> AI Provider
                </h2>
                <div>
                  <label className={labelCls}>Active Provider</label>
                  <select
                    className={inputCls}
                    value={settings.providers.activeProvider}
                    onChange={(e) => setProvider("activeProvider", e.target.value)}
                  >
                    <option value="openai-compatible" className="bg-gray-800">OpenAI Compatible</option>
                    <option value="anthropic" className="bg-gray-800">Anthropic</option>
                    <option value="codex-cli" className="bg-gray-800">Codex CLI</option>
                    <option value="claude-cli" className="bg-gray-800">Claude CLI</option>
                  </select>
                </div>

                {settings.providers.activeProvider === "openai-compatible" && (
                  <div className="space-y-3 pt-2 border-t border-white/10">
                    <div>
                      <label className={labelCls}>API Base URL</label>
                      <input className={inputCls} value={settings.providers.openaiCompatible.baseUrl}
                        onChange={(e) => setProvider("openaiCompatible", { ...settings.providers.openaiCompatible, baseUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1" />
                    </div>
                    <div>
                      <label className={labelCls}>API Key</label>
                      <input className={inputCls} type="password" value={settings.providers.openaiCompatible.apiKey}
                        onChange={(e) => setProvider("openaiCompatible", { ...settings.providers.openaiCompatible, apiKey: e.target.value })}
                        placeholder="sk-…" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>Chat Model</label>
                        <input className={inputCls} value={settings.providers.openaiCompatible.model}
                          onChange={(e) => setProvider("openaiCompatible", { ...settings.providers.openaiCompatible, model: e.target.value })}
                          placeholder="gpt-4.1-mini" />
                      </div>
                      <div>
                        <label className={labelCls}>Embedding Model</label>
                        <input className={inputCls} value={settings.providers.openaiCompatible.embeddingModel}
                          onChange={(e) => setProvider("openaiCompatible", { ...settings.providers.openaiCompatible, embeddingModel: e.target.value })}
                          placeholder="text-embedding-3-small" />
                      </div>
                    </div>
                  </div>
                )}

                {settings.providers.activeProvider === "anthropic" && (
                  <div className="space-y-3 pt-2 border-t border-white/10">
                    <div>
                      <label className={labelCls}>API Key</label>
                      <input className={inputCls} type="password" value={settings.providers.anthropic.apiKey}
                        onChange={(e) => setProvider("anthropic", { ...settings.providers.anthropic, apiKey: e.target.value })}
                        placeholder="sk-ant-…" />
                    </div>
                    <div>
                      <label className={labelCls}>Model</label>
                      <input className={inputCls} value={settings.providers.anthropic.model}
                        onChange={(e) => setProvider("anthropic", { ...settings.providers.anthropic, model: e.target.value })}
                        placeholder="claude-3-5-sonnet-latest" />
                    </div>
                  </div>
                )}

                {settings.providers.activeProvider === "codex-cli" && (
                  <div className="space-y-3 pt-2 border-t border-white/10">
                    <div>
                      <label className={labelCls}>Command</label>
                      <input className={inputCls} value={settings.providers.codexCli.command}
                        onChange={(e) => setProvider("codexCli", { ...settings.providers.codexCli, command: e.target.value })}
                        placeholder="codex" />
                    </div>
                    <div>
                      <label className={labelCls}>Args Template</label>
                      <input className={inputCls} value={settings.providers.codexCli.argsTemplate}
                        onChange={(e) => setProvider("codexCli", { ...settings.providers.codexCli, argsTemplate: e.target.value })}
                        placeholder="-q {{prompt}}" />
                    </div>
                  </div>
                )}

                {settings.providers.activeProvider === "claude-cli" && (
                  <div className="space-y-3 pt-2 border-t border-white/10">
                    <div>
                      <label className={labelCls}>Command</label>
                      <input className={inputCls} value={settings.providers.claudeCli.command}
                        onChange={(e) => setProvider("claudeCli", { ...settings.providers.claudeCli, command: e.target.value })}
                        placeholder="claude" />
                    </div>
                    <div>
                      <label className={labelCls}>Args Template</label>
                      <input className={inputCls} value={settings.providers.claudeCli.argsTemplate}
                        onChange={(e) => setProvider("claudeCli", { ...settings.providers.claudeCli, argsTemplate: e.target.value })}
                        placeholder="-p {{prompt}}" />
                    </div>
                  </div>
                )}
              </div>

              {/* TTS */}
              <div className={sectionCls}>
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <span>🔊</span> Text-to-Speech
                </h2>
                <div>
                  <label className={labelCls}>TTS Provider</label>
                  <select
                    className={inputCls}
                    value={settings.tts.provider}
                    onChange={(e) => setTts("provider", e.target.value)}
                  >
                    <option value="openai-compatible" className="bg-gray-800">OpenAI Compatible</option>
                    <option value="system-say" className="bg-gray-800">System Say (macOS)</option>
                  </select>
                </div>
                {settings.tts.provider === "openai-compatible" && (
                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/10">
                    <div>
                      <label className={labelCls}>Voice</label>
                      <input className={inputCls} value={settings.tts.voice}
                        onChange={(e) => setTts("voice", e.target.value)} placeholder="alloy" />
                    </div>
                    <div>
                      <label className={labelCls}>Model</label>
                      <input className={inputCls} value={settings.tts.model}
                        onChange={(e) => setTts("model", e.target.value)} placeholder="gpt-4o-mini-tts" />
                    </div>
                  </div>
                )}
                {settings.tts.provider === "system-say" && (
                  <div className="pt-2 border-t border-white/10">
                    <label className={labelCls}>System Voice</label>
                    <input className={inputCls} value={settings.tts.systemVoice}
                      onChange={(e) => setTts("systemVoice", e.target.value)} placeholder="Samantha" />
                  </div>
                )}
              </div>

              {/* Preferences */}
              <div className={sectionCls}>
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <span>🎯</span> Preferences
                </h2>
                <div>
                  <label className={labelCls}>Topics <span className="text-white/40 font-normal">(comma-separated)</span></label>
                  <input className={inputCls}
                    value={settings.preferences.topics.join(", ")}
                    onChange={(e) => setSettings((s) => ({ ...s, preferences: { ...s.preferences, topics: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) } }))}
                    placeholder="technology, business, science" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Region</label>
                    <input className={inputCls} value={settings.preferences.region}
                      onChange={(e) => setSettings((s) => ({ ...s, preferences: { ...s.preferences, region: e.target.value } }))}
                      placeholder="US" />
                  </div>
                  <div>
                    <label className={labelCls}>Language</label>
                    <input className={inputCls} value={settings.preferences.language}
                      onChange={(e) => setSettings((s) => ({ ...s, preferences: { ...s.preferences, language: e.target.value } }))}
                      placeholder="en" />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Daily briefing story count</label>
                  <input
                    className={inputCls}
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
              <div className={sectionCls}>
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <span>📰</span> News Sources
                </h2>

                {/* Simple toggles */}
                <div className="space-y-2">
                  {(
                    [
                      { key: "hackerNewsEnabled",    label: "Hacker News" },
                      { key: "lobstersEnabled",       label: "Lobsters" },
                      { key: "githubTrendingEnabled", label: "GitHub Trending" },
                      { key: "slashdotEnabled",       label: "Slashdot" },
                      { key: "productHuntEnabled",    label: "Product Hunt" },
                    ] as { key: keyof AppSettings["sources"]; label: string }[]
                  ).map(({ key, label }) => (
                    <label key={key} className="flex items-center justify-between cursor-pointer">
                      <span className="text-white/80 text-sm">{label}</span>
                      <input
                        type="checkbox"
                        checked={settings.sources[key] as boolean}
                        onChange={(e) => setSources(key, e.target.checked)}
                        className="w-4 h-4 accent-amber-500"
                      />
                    </label>
                  ))}
                </div>

                {/* Reddit */}
                <div className="pt-3 border-t border-white/10 space-y-2">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-white/80 text-sm font-medium">Reddit</span>
                    <input type="checkbox" checked={settings.sources.redditEnabled}
                      onChange={(e) => setSources("redditEnabled", e.target.checked)}
                      className="w-4 h-4 accent-amber-500" />
                  </label>
                  {settings.sources.redditEnabled && (
                    <div>
                      <label className={labelCls}>Subreddits <span className="text-white/40 font-normal">(comma-separated)</span></label>
                      <input className={inputCls}
                        value={settings.sources.redditSubreddits.join(", ")}
                        onChange={(e) => setSources("redditSubreddits", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
                        placeholder="technology, worldnews" />
                    </div>
                  )}
                </div>

                {/* Dev.to */}
                <div className="pt-3 border-t border-white/10 space-y-2">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-white/80 text-sm font-medium">Dev.to</span>
                    <input type="checkbox" checked={settings.sources.devToEnabled}
                      onChange={(e) => setSources("devToEnabled", e.target.checked)}
                      className="w-4 h-4 accent-amber-500" />
                  </label>
                  {settings.sources.devToEnabled && (
                    <div>
                      <label className={labelCls}>Tags <span className="text-white/40 font-normal">(comma-separated)</span></label>
                      <input className={inputCls}
                        value={settings.sources.devToTags.join(", ")}
                        onChange={(e) => setSources("devToTags", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
                        placeholder="javascript, webdev" />
                    </div>
                  )}
                </div>

                {/* Google News */}
                <div className="pt-3 border-t border-white/10 space-y-2">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-white/80 text-sm font-medium">Google News</span>
                    <input type="checkbox" checked={settings.sources.googleNewsEnabled}
                      onChange={(e) => setSources("googleNewsEnabled", e.target.checked)}
                      className="w-4 h-4 accent-amber-500" />
                  </label>
                  {settings.sources.googleNewsEnabled && (
                    <div>
                      <label className={labelCls}>Topics <span className="text-white/40 font-normal">(comma-separated)</span></label>
                      <input className={inputCls}
                        value={settings.sources.googleNewsTopics.join(", ")}
                        onChange={(e) => setSources("googleNewsTopics", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
                        placeholder="technology, business" />
                    </div>
                  )}
                </div>
              </div>

              {/* Save bar */}
              <div className="flex items-center justify-between pt-2">
                {saveMsg ? (
                  <span className={`text-sm font-medium ${saveMsg.ok ? "text-green-400" : "text-red-400"}`}>
                    {saveMsg.text}
                  </span>
                ) : <span />}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => fetchSettings()}
                    className="px-4 py-2 text-sm text-white/70 hover:text-white border border-white/20 hover:border-white/40 rounded-md transition-colors"
                  >
                    Refresh
                  </button>
                  <button
                    onClick={saveSettings}
                    disabled={saving}
                    className="px-6 py-2 text-sm font-semibold bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-md transition-colors"
                  >
                    {saving ? (
                      <span className="flex items-center gap-2">
                        <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
                        Saving…
                      </span>
                    ) : "Save Settings"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
