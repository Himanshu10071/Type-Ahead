/**
 * SuggestionDropdown.tsx — Renders the floating suggestion list.
 * Highlights the typed prefix within each suggestion in a contrasting colour.
 */

import React from 'react';
import { Suggestion } from '../api/client';

interface Props {
  suggestions: Suggestion[];
  query: string;
  activeIndex: number;
  onSelect: (suggestion: Suggestion) => void;
  onHover: (index: number) => void;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function HighlightedText({ text, highlight }: { text: string; highlight: string }) {
  if (!highlight.trim()) return <span>{text}</span>;

  const lowerText = text.toLowerCase();
  const lowerHighlight = highlight.toLowerCase().trim();
  const startIdx = lowerText.indexOf(lowerHighlight);

  if (startIdx === -1) return <span>{text}</span>;

  return (
    <>
      <span className="suggestion-prefix">{text.slice(0, startIdx + lowerHighlight.length)}</span>
      <span className="suggestion-suffix">{text.slice(startIdx + lowerHighlight.length)}</span>
    </>
  );
}

export function SuggestionDropdown({ suggestions, query, activeIndex, onSelect, onHover }: Props) {
  if (suggestions.length === 0) return null;

  return (
    <div className="suggestion-dropdown" role="listbox" aria-label="Search suggestions">
      {suggestions.map((s, idx) => (
        <div
          key={s.query}
          role="option"
          aria-selected={idx === activeIndex}
          className={`suggestion-item ${idx === activeIndex ? 'suggestion-item--active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent input blur before click registers
            onSelect(s);
          }}
          onMouseEnter={() => onHover(idx)}
          id={`suggestion-${idx}`}
        >
          <span className="suggestion-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </span>
          <span className="suggestion-text">
            <HighlightedText text={s.query} highlight={query} />
          </span>
          <span className="suggestion-count">{formatCount(s.count)}</span>
        </div>
      ))}
    </div>
  );
}
