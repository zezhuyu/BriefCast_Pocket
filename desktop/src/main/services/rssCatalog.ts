import fs from "node:fs";
import path from "node:path";

interface RssRow {
  country: string;
  sector: string;
  url: string;
}

function normalizeTopic(topic: string): string {
  const t = topic.trim().toLowerCase();
  if (!t) return "";
  if (t === "technology") return "tech";
  if (t === "politic") return "politics";
  return t;
}

function parseCsvLine(line: string): RssRow | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const firstComma = trimmed.indexOf(",");
  if (firstComma < 0) {
    return null;
  }

  const secondComma = trimmed.indexOf(",", firstComma + 1);
  if (secondComma < 0) {
    return null;
  }

  const country = trimmed.slice(0, firstComma).trim().toUpperCase();
  const sector = normalizeTopic(trimmed.slice(firstComma + 1, secondComma));
  const url = trimmed.slice(secondComma + 1).trim();

  if (!country || !url.startsWith("http")) {
    return null;
  }

  return { country, sector, url };
}

function readRows(csvPath: string): RssRow[] {
  const raw = fs.readFileSync(csvPath, "utf8");
  const rows: RssRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const row = parseCsvLine(line);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

export function resolveRssCsvPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "../backend/db/rss.csv"),
    path.resolve(process.cwd(), "backend/db/rss.csv"),
    path.resolve(process.cwd(), "../../backend/db/rss.csv"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function loadRssFeedsFromCsv(region: string, topics: string[]): string[] {
  const csvPath = resolveRssCsvPath();
  if (!csvPath) {
    return [];
  }

  const rows = readRows(csvPath);
  const wantedCountry = region.trim().toUpperCase() || "US";
  const wantedTopics = new Set(topics.map(normalizeTopic).filter(Boolean));
  wantedTopics.add("general");

  const selected = rows.filter((row) => row.country === wantedCountry && wantedTopics.has(row.sector));
  const base = selected.length ? selected : rows.filter((row) => row.country === wantedCountry);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const row of base) {
    if (!seen.has(row.url)) {
      seen.add(row.url);
      unique.push(row.url);
    }
  }

  return unique;
}
