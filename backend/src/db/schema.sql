-- schema.sql — SQLite source-of-truth schema for the typeahead system.
-- This file is for documentation; the schema is also applied inline in database.ts.

-- Primary query store.
-- `query`      = original casing, used for display.
-- `normalized` = lowercase trimmed, used for indexing and cache keys.
-- `count`      = cumulative search count (all-time).
CREATE TABLE IF NOT EXISTS queries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  query      TEXT    NOT NULL,
  normalized TEXT    NOT NULL UNIQUE,
  count      INTEGER NOT NULL DEFAULT 0
);

-- Fast prefix-range scans on the normalised column.
CREATE INDEX IF NOT EXISTS idx_normalized ON queries (normalized);

-- Hourly activity buckets for trending computation.
-- `hour_bucket` = Unix epoch milliseconds floored to the nearest hour.
-- Rows older than 24 hours are not loaded on startup and are ignored in scoring.
CREATE TABLE IF NOT EXISTS trending_buckets (
  normalized  TEXT    NOT NULL,
  hour_bucket INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (normalized, hour_bucket)
);
