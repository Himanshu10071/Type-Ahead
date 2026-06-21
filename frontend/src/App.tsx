/**
 * App.tsx — Root application component.
 */
import React, { useState, useCallback } from 'react';
import { SearchBar } from './components/SearchBar';
import { TrendingSection } from './components/TrendingSection';
import { useTrending } from './hooks/useTrending';

export default function App() {
  const [currentQuery, setCurrentQuery] = useState('');
  const { trending, loading: trendingLoading, error: trendingError, refresh } = useTrending(30_000);

  const handleQuerySelect = useCallback((query: string) => {
    setCurrentQuery(query);
    // Refresh trending after a search so the new data shows up quickly
    setTimeout(refresh, 1_500);
  }, [refresh]);

  return (
    <div className="app">
      {/* Background decorative elements */}
      <div className="bg-orb bg-orb--1" aria-hidden="true" />
      <div className="bg-orb bg-orb--2" aria-hidden="true" />
      <div className="bg-orb bg-orb--3" aria-hidden="true" />
      <div className="bg-grid" aria-hidden="true" />

      <main className="main-content">
        {/* Hero section */}
        <header className="hero">
          <div className="logo-mark" aria-hidden="true">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <defs>
                <linearGradient id="logo-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#7c3aed" />
                  <stop offset="100%" stopColor="#2563eb" />
                </linearGradient>
              </defs>
              <circle cx="22" cy="22" r="14" stroke="url(#logo-gradient)" strokeWidth="3" />
              <line x1="32" y1="32" x2="44" y2="44" stroke="url(#logo-gradient)" strokeWidth="3" strokeLinecap="round" />
              <circle cx="22" cy="22" r="6" fill="url(#logo-gradient)" opacity="0.3" />
            </svg>
          </div>
          <h1 className="hero-title">
            Type<span className="hero-accent">Ahead</span>
          </h1>
          <p className="hero-subtitle">
            Distributed search with real-time suggestions, consistent-hashing Redis cache &amp; trending analytics
          </p>

          {/* Tech stack badges */}
          <div className="tech-badges" aria-label="Technology stack">
            {['Fastify', 'SQLite', 'Redis × 3', 'Trie Index', 'Batch Writer'].map((t) => (
              <span key={t} className="tech-badge">{t}</span>
            ))}
          </div>
        </header>

        {/* Search interface */}
        <section className="search-section" aria-label="Search">
          <SearchBar onQuerySelect={handleQuerySelect} />
          {currentQuery && (
            <p className="current-query-hint">
              Last searched: <span className="current-query-value">"{currentQuery}"</span>
            </p>
          )}
        </section>

        {/* Trending searches */}
        <TrendingSection
          trending={trending}
          loading={trendingLoading}
          error={trendingError}
          onQueryClick={(query) => {
            setCurrentQuery(query);
          }}
          onRefresh={refresh}
        />

        {/* Footer */}
        <footer className="app-footer">
          <p>
            Built with Node.js · Fastify · SQLite · Redis · React · Vite
          </p>
          <div className="footer-links">
            <a href="/metrics" target="_blank" rel="noreferrer" className="footer-link">
              📊 Metrics
            </a>
            <a href="/cache/debug?prefix=a" target="_blank" rel="noreferrer" className="footer-link">
              🔍 Cache Debug
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}
