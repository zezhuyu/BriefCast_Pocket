"use client";

const DEFAULT_BACKEND_BASE = "http://127.0.0.1:5002/";

export const getBackendBase = (): string => {
  const raw = process.env.NEXT_PUBLIC_BACKEND_URL ?? DEFAULT_BACKEND_BASE;
  return raw.endsWith("/") ? raw : `${raw}/`;
};

export const backendUrl = (path: string): string => {
  const normalizedPath = path.replace(/^\/+/, "");
  return `${getBackendBase()}${normalizedPath}`;
};
