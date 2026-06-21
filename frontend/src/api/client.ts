/**
 * client.ts — Typed API client for the typeahead backend.
 * Uses the native Fetch API (available in all modern browsers and Node 18+).
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

export interface Suggestion {
  query: string;
  count: number;
}

export interface TrendingEntry {
  query: string;
  score: number;
  count: number;
  recencyScore: number;
}

export interface SearchResponse {
  message: string;
}

export interface CacheDebugResponse {
  prefix: string;
  key: string;
  hash: number;
  cacheNode: string;
  cacheHit: boolean;
}

export interface MetricsResponse {
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  searchRequests: number;
  dbReads: number;
  dbWrites: number;
  writesAvoided: number;
  batchFlushes: number;
  queueDepth: number;
  p95LatencyMs: number;
  latencySamples: number;
}

async function fetchJSON<T>(
  url: string,
  options?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, {
    ...options,
    signal,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  suggest(prefix: string, signal?: AbortSignal): Promise<Suggestion[]> {
    return fetchJSON<Suggestion[]>(
      `/suggest?q=${encodeURIComponent(prefix)}`,
      {},
      signal,
    );
  },

  search(query: string): Promise<SearchResponse> {
    return fetchJSON<SearchResponse>('/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  },

  trending(): Promise<TrendingEntry[]> {
    return fetchJSON<TrendingEntry[]>('/trending');
  },

  cacheDebug(prefix: string): Promise<CacheDebugResponse> {
    return fetchJSON<CacheDebugResponse>(
      `/cache/debug?prefix=${encodeURIComponent(prefix)}`,
    );
  },

  metrics(): Promise<MetricsResponse> {
    return fetchJSON<MetricsResponse>('/metrics');
  },
};
