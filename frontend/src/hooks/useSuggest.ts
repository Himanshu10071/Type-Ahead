/**
 * useSuggest.ts — Debounced typeahead suggestion hook.
 *
 * Debounce delay: 200 ms
 *   Chosen as the sweet spot between perceived responsiveness and avoiding
 *   a network request on every keystroke.  Studies show users don't perceive
 *   delays below ~150–200 ms as lag, so 200 ms gives one round-trip savings
 *   per burst of typing without any UX cost.
 *
 * AbortController:
 *   Each new debounced request cancels the previous in-flight fetch so
 *   out-of-order responses never corrupt the displayed suggestions.
 */

import { useState, useEffect, useRef } from 'react';
import { api, Suggestion } from '../api/client';

interface UseSuggestResult {
  suggestions: Suggestion[];
  loading: boolean;
  error: string | null;
}

export function useSuggest(query: string, delay = 200): UseSuggestResult {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep a stable ref to the current AbortController so we can cancel it
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();

    if (!trimmed) {
      setSuggestions([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Start the debounce timer
    const timer = setTimeout(async () => {
      // Cancel any in-flight request from the previous debounce window
      if (abortRef.current) {
        abortRef.current.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const results = await api.suggest(trimmed, controller.signal);
        setSuggestions(results);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          // Silently ignore aborted requests — a newer one is already in flight
          return;
        }
        setError(err instanceof Error ? err.message : 'Request failed');
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, delay);

    // Cleanup: cancel the timer if the query changes before delay elapses
    return () => {
      clearTimeout(timer);
    };
  }, [query, delay]);

  return { suggestions, loading, error };
}
