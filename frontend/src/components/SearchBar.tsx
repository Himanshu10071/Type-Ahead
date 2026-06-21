/**
 * SearchBar.tsx — Main search input with live suggestions and keyboard navigation.
 *
 * Keyboard behaviour:
 *   ArrowDown / ArrowUp — move activeIndex through suggestions
 *   Enter (with active suggestion) — select the highlighted suggestion
 *   Enter (no active / empty) — submit current input text as a search
 *   Escape — close the dropdown without submitting
 *
 * The input maintains focus even after selecting a suggestion so the user
 * can immediately type another query.
 */

import React, { useState, useRef, useCallback, useId } from 'react';
import { useSuggest } from '../hooks/useSuggest';
import { SuggestionDropdown } from './SuggestionDropdown';
import { api, Suggestion } from '../api/client';

interface Props {
  onQuerySelect?: (query: string) => void;
}

interface SearchResult {
  query: string;
  success: boolean;
  message?: string;
}

export function SearchBar({ onQuerySelect }: Props) {
  const [inputValue, setInputValue] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isOpen, setIsOpen] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const { suggestions, loading, error } = useSuggest(isOpen ? inputValue : '');

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setActiveIndex(-1);
    setIsOpen(true);
    setSearchResult(null);
  }, []);

  const submitSearch = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;

    setSubmitting(true);
    setIsOpen(false);
    setActiveIndex(-1);

    try {
      const res = await api.search(trimmed);
      setSearchResult({ query: trimmed, success: true, message: res.message });
      onQuerySelect?.(trimmed);
    } catch (err) {
      setSearchResult({
        query: trimmed,
        success: false,
        message: err instanceof Error ? err.message : 'Search failed',
      });
    } finally {
      setSubmitting(false);
    }
  }, [onQuerySelect]);

  const handleSelect = useCallback((suggestion: Suggestion) => {
    setInputValue(suggestion.query);
    setIsOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
    void submitSearch(suggestion.query);
  }, [submitSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!isOpen || suggestions.length === 0) {
        if (e.key === 'Enter') {
          e.preventDefault();
          void submitSearch(inputValue);
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % suggestions.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((prev) =>
            prev <= 0 ? suggestions.length - 1 : prev - 1,
          );
          break;
        case 'Enter':
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < suggestions.length) {
            handleSelect(suggestions[activeIndex]);
          } else {
            void submitSearch(inputValue);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setIsOpen(false);
          setActiveIndex(-1);
          break;
      }
    },
    [isOpen, suggestions, activeIndex, inputValue, handleSelect, submitSearch],
  );

  const handleFocus = useCallback(() => {
    if (inputValue.trim()) setIsOpen(true);
  }, [inputValue]);

  const handleBlur = useCallback(() => {
    // Delay close so click on suggestion fires first
    setTimeout(() => setIsOpen(false), 150);
  }, []);

  const handleSearchButtonClick = useCallback(() => {
    void submitSearch(inputValue);
  }, [inputValue, submitSearch]);

  return (
    <div className="search-bar-wrapper">
      <div
        className={`search-bar-container ${isOpen && (suggestions.length > 0 || loading) ? 'search-bar-container--open' : ''}`}
        role="combobox"
        aria-expanded={isOpen && suggestions.length > 0}
        aria-haspopup="listbox"
        aria-owns={listboxId}
      >
        {/* Search icon */}
        <span className="search-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </span>

        <input
          ref={inputRef}
          id="search-input"
          type="text"
          className="search-input"
          placeholder="Search anything…"
          value={inputValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={
            activeIndex >= 0 ? `suggestion-${activeIndex}` : undefined
          }
        />

        {/* Loading spinner */}
        {loading && (
          <span className="search-spinner" aria-label="Loading suggestions">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </span>
        )}

        {/* Clear button */}
        {inputValue && !loading && (
          <button
            className="clear-btn"
            onClick={() => {
              setInputValue('');
              setIsOpen(false);
              setActiveIndex(-1);
              setSearchResult(null);
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}

        <button
          id="search-submit-btn"
          className={`search-submit-btn ${submitting ? 'search-submit-btn--loading' : ''}`}
          onClick={handleSearchButtonClick}
          disabled={submitting || !inputValue.trim()}
          aria-label="Submit search"
        >
          {submitting ? (
            <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          )}
          <span>Search</span>
        </button>
      </div>

      {/* Suggestion dropdown */}
      {isOpen && (
        <div id={listboxId}>
          <SuggestionDropdown
            suggestions={suggestions}
            query={inputValue}
            activeIndex={activeIndex}
            onSelect={handleSelect}
            onHover={setActiveIndex}
          />
        </div>
      )}

      {/* Error from suggest */}
      {error && isOpen && (
        <div className="suggest-error" role="alert">
          ⚠️ Could not fetch suggestions: {error}
        </div>
      )}

      {/* Search result banner */}
      {searchResult && (
        <div
          className={`search-result-banner ${searchResult.success ? 'search-result-banner--success' : 'search-result-banner--error'}`}
          role="status"
          aria-live="polite"
        >
          {searchResult.success ? (
            <>
              <span className="result-check">✓</span>
              <span>
                Searched for <strong>"{searchResult.query}"</strong> — recorded for trending!
              </span>
            </>
          ) : (
            <>
              <span className="result-x">✕</span>
              <span>Search failed: {searchResult.message}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
