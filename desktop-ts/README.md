# BriefCast Desktop TS Rewrite

This is a pure JavaScript/TypeScript desktop rewrite of BriefCast using Electron + React.

## What this version adds

- Desktop app runtime in TypeScript (`Electron + React + Vite`)
- Pluggable generation providers:
  - OpenAI-compatible API
  - Anthropic API (Claude)
  - `codex` CLI
  - `claude` CLI
- Simple JSON file database (metadata + vectors)
  - Articles and vectors stored in `briefcast.json`
  - Keyword search
  - Semantic vector search
  - Hybrid search (keyword + semantic)
- News ingestion from multiple channels:
  - RSS feeds
  - Hacker News API
  - Reddit JSON API
- RSS source bootstrap from `backend/db/rss.csv`

## Run

```bash
cd desktop-ts
npm install
npm run dev
```

## Build

```bash
cd desktop-ts
npm run build
```

## Notes

- Settings are stored in Electron user data at `settings.json`.
- JSON database is stored in Electron user data at `data/briefcast.json`.
- Semantic search works without external embedding APIs via local fallback embeddings.
- For best semantic quality, configure OpenAI-compatible embedding model in settings.
- CLI providers require installed commands in PATH:
  - `codex`
  - `claude`
- A local compatibility API bridge starts on `127.0.0.1:5002` by default (set `BRIEFCAST_API_PORT` to change):
  - REST: `/api/settings`, `/api/news/sync`, `/api/news/search`, `/api/briefings`, `/api/briefings/generate`
  - GraphQL: `/graphql`
  - MCP JSON-RPC: `/mcp`
