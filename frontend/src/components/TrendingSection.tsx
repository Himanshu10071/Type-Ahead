/**
 * TrendingSection.tsx — Displays the top trending queries with their scores.
 */

import React from 'react';
import { TrendingEntry } from '../api/client';

interface Props {
  trending: TrendingEntry[];
  loading: boolean;
  error: string | null;
  onQueryClick: (query: string) => void;
  onRefresh: () => void;
}

const TREND_ICONS = ['🔥', '⚡', '🚀', '💫', '✨', '🎯', '💡', '🌟', '⭐', '🎆'];

function ScoreBar({ score, maxScore }: { score: number; maxScore: number }) {
  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  return (
    <div className="score-bar-track" aria-hidden="true">
      <div className="score-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M searches`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K searches`;
  return `${n} searches`;
}

export function TrendingSection({ trending, loading, error, onQueryClick, onRefresh }: Props) {
  const maxScore = trending.length > 0 ? trending[0].score : 1;

  return (
    <section className="trending-section" aria-labelledby="trending-title">
      <div className="trending-header">
        <h2 id="trending-title" className="trending-title">
          <span className="trending-title-icon">🔥</span>
          Trending Searches
        </h2>
        <button
          className="refresh-btn"
          onClick={onRefresh}
          aria-label="Refresh trending searches"
          title="Refresh"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </button>
      </div>

      {loading && trending.length === 0 && (
        <div className="trending-skeleton">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton-card" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      )}

      {error && (
        <div className="trending-error">
          <span>⚠️ {error}</span>
          <button onClick={onRefresh} className="retry-btn">Retry</button>
        </div>
      )}

      {!error && trending.length > 0 && (
        <div className="trending-grid">
          {trending.map((entry, idx) => (
            <button
              key={entry.query}
              className="trending-card"
              onClick={() => onQueryClick(entry.query)}
              aria-label={`Search for ${entry.query}, score ${entry.score.toFixed(3)}`}
              style={{ animationDelay: `${idx * 60}ms` }}
            >
              <div className="trending-card-rank">
                <span className="rank-icon">{TREND_ICONS[idx] ?? '🔎'}</span>
                <span className="rank-number">#{idx + 1}</span>
              </div>
              <div className="trending-card-body">
                <span className="trending-query">{entry.query}</span>
                <span className="trending-meta">{formatCount(entry.count)}</span>
              </div>
              <div className="trending-card-score">
                <ScoreBar score={entry.score} maxScore={maxScore} />
                <span className="score-value">{entry.score.toFixed(3)}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {!error && !loading && trending.length === 0 && (
        <div className="trending-empty">
          <span>No trending data yet — start searching to generate trends.</span>
        </div>
      )}
    </section>
  );
}
