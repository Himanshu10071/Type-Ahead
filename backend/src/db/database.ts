/**
 * database.ts — better-sqlite3 wrapper providing typed helpers for all
 * database operations used by the typeahead system.
 *
 * Design notes:
 * - WAL mode is enabled for concurrent read performance.
 * - synchronous = NORMAL provides a good durability/performance balance.
 * - All writes use UPSERT (INSERT OR ... ON CONFLICT) to be idempotent.
 */
import BetterSqlite3, { Database as Db } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface QueryRow {
  id: number;
  query: string;
  normalized: string;
  count: number;
}

export interface TrendingBucketRow {
  normalized: string;
  hour_bucket: number;
  count: number;
}

export class DatabaseService {
  private readonly db: Db;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.applySchema();
  }

  // ─── Schema ────────────────────────────────────────────────────────────────

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        query      TEXT    NOT NULL,
        normalized TEXT    NOT NULL UNIQUE,
        count      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_normalized ON queries (normalized);

      CREATE TABLE IF NOT EXISTS trending_buckets (
        normalized  TEXT    NOT NULL,
        hour_bucket INTEGER NOT NULL,
        count       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (normalized, hour_bucket)
      );
    `);
  }

  // ─── Query helpers ─────────────────────────────────────────────────────────

  /** Load every query row — used once on startup to build the trie. */
  getAllQueries(): QueryRow[] {
    return this.db.prepare('SELECT * FROM queries ORDER BY count DESC').all() as QueryRow[];
  }

  /** Count total rows in the queries table. */
  getQueryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM queries').get() as { n: number };
    return row.n;
  }

  /**
   * Bulk-upsert a list of { query, normalized, count } rows in a single
   * transaction.  Idempotent: re-running with the same data keeps existing
   * rows if their counts are already higher.
   *
   * Used by the ingestion script.
   */
  bulkUpsertQueries(
    rows: Array<{ query: string; normalized: string; count: number }>,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO queries (query, normalized, count)
      VALUES (?, ?, ?)
      ON CONFLICT(normalized) DO UPDATE SET
        query = excluded.query,
        count = MAX(excluded.count, queries.count)
    `);
    const runAll = this.db.transaction(
      (items: Array<{ query: string; normalized: string; count: number }>) => {
        for (const item of items) {
          stmt.run(item.query, item.normalized, item.count);
        }
      },
    );
    runAll(rows);
  }

  /**
   * Batch-increment query counts from a Map<normalized, delta>.
   * All increments run in a single SQLite transaction.
   * New queries are inserted with count = delta.
   *
   * Returns a Map<normalized, newCount> with the updated counts after the flush,
   * which the batch writer uses to update the trie.
   */
  batchIncrementCounts(updates: Map<string, number>): Map<string, number> {
    const upsertStmt = this.db.prepare(`
      INSERT INTO queries (query, normalized, count)
      VALUES (?, ?, ?)
      ON CONFLICT(normalized) DO UPDATE SET count = count + excluded.count
    `);
    const selectStmt = this.db.prepare(
      'SELECT count FROM queries WHERE normalized = ?',
    );

    const newCounts = new Map<string, number>();

    const tx = this.db.transaction(() => {
      for (const [normalized, delta] of updates) {
        upsertStmt.run(normalized, normalized, delta);
      }
      // Fetch updated counts after the transaction commits
      for (const [normalized] of updates) {
        const row = selectStmt.get(normalized) as { count: number } | undefined;
        if (row) newCounts.set(normalized, row.count);
      }
    });
    tx();

    return newCounts;
  }

  // ─── Trending bucket helpers ────────────────────────────────────────────────

  /**
   * Load all trending bucket rows that are within the last 24 hours.
   * Called once on startup to restore in-memory trending state.
   */
  getRecentTrendingBuckets(): TrendingBucketRow[] {
    const cutoff =
      Math.floor(Date.now() / 3_600_000) * 3_600_000 - 24 * 3_600_000;
    return this.db
      .prepare('SELECT * FROM trending_buckets WHERE hour_bucket >= ?')
      .all(cutoff) as TrendingBucketRow[];
  }

  /**
   * Upsert a batch of trending bucket increments in a single transaction.
   * Called by the batch writer after each flush.
   */
  batchUpsertTrendingBuckets(
    items: Array<{ normalized: string; hourBucket: number; count: number }>,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO trending_buckets (normalized, hour_bucket, count)
      VALUES (?, ?, ?)
      ON CONFLICT(normalized, hour_bucket) DO UPDATE SET count = count + excluded.count
    `);
    const tx = this.db.transaction(
      (rows: Array<{ normalized: string; hourBucket: number; count: number }>) => {
        for (const row of rows) {
          stmt.run(row.normalized, row.hourBucket, row.count);
        }
      },
    );
    tx(items);
  }

  /** Expose raw DB handle for the batch writer to run combined transactions. */
  getRaw(): Db {
    return this.db;
  }

  /** Flush all WAL frames to the main database file. Safe to call anytime. */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(PASSIVE)');
  }

  close(): void {
    this.db.close();
  }
}
