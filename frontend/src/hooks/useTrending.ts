/**
 * useTrending.ts — Fetches trending searches on mount and refreshes every 30 s.
 */

import { useState, useEffect, useCallback } from 'react';
import { api, TrendingEntry } from '../api/client';

interface UseTrendingResult {
  trending: TrendingEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useTrending(refreshIntervalMs = 30_000): UseTrendingResult {
  const [trending, setTrending] = useState<TrendingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.trending();
      setTrending(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load trending');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetch();
    const interval = setInterval(() => void fetch(), refreshIntervalMs);
    return () => clearInterval(interval);
  }, [fetch, refreshIntervalMs]);

  return { trending, loading, error, refresh: fetch };
}
