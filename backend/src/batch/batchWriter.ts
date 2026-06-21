/**
 * batchWriter.ts — In-memory queue → aggregator → batch writer pipeline.
 *
 * Flow
 * ────
 *   POST /search
 *       │
 *       ▼
 *   enqueue(normalized)          — O(1), thread-safe (Node is single-threaded)
 *       │
 *       ▼
 *   In-Memory Map<normalized, delta>   ← deduplication (aggregation)
 *       │
 *   flush() on: batchSize reached  OR  flushInterval elapsed
 *       │
 *       ▼
 *   SQLite UPSERT transaction (single TX for all updates)
 *       │
 *       ├── update in-memory trie (trie.update per query)
 *       ├── update in-memory trending buckets
 *       ├── persist trending buckets to SQLite
 *       └── invalidate affected Redis cache keys (all prefixes of each query)
 *
 * Durability / crash tradeoff (documented per spec §6)
 * ──────────────────────────────────────────────────────
 * The in-memory queue is lost on process crash (at-most-once delivery).
 * For a typeahead search-count system, losing a few search increments is
 * entirely acceptable — the data is statistical, not transactional.
 *
 * Durability options (not implemented here):
 *   A. Write-ahead log: append each POST /search to a local log file before
 *      enqueuing; replay on restart. Adds ~1 ms disk I/O per request.
 *   B. Redis Stream: push each query into a Redis Stream (durable log);
 *      the batch writer consumes and acknowledges.  Requires Redis AOF/RDB.
 *   C. Kafka / Pulsar: full message-queue durability with replication.
 *
 * This implementation deliberately picks the simplest option (at-most-once)
 * because: (1) typeahead count accuracy is a best-effort metric, (2) it
 * avoids the added latency and operational complexity of a durable queue.
 */

import { DatabaseService } from '../db/database';
import { Trie } from '../trie/trie';
import { ConsistentHashRing } from '../cache/consistentHash';
import { TrendingManager } from '../trending/trending';
import { Metrics } from '../metrics/metrics';

export class BatchWriter {
  /**
   * The aggregation map.  Key = normalised query; value = total delta since
   * the last flush.  Multiple searches for the same query within a batch
   * window are summed here, producing a single DB UPSERT per unique query.
   */
  private readonly queue: Map<string, number> = new Map();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly trie: Trie,
    private readonly hashRing: ConsistentHashRing,
    private readonly trending: TrendingManager,
    private readonly metrics: Metrics,
    private readonly batchSize: number,
    private readonly flushIntervalMs: number,
    private readonly cacheTtlSeconds: number,
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush on graceful shutdown
    await this.flush();
  }

  // ─── Enqueue ──────────────────────────────────────────────────────────────

  /**
   * Enqueue a normalised query for batch processing.
   * Returns immediately — the caller (POST /search) never waits for I/O.
   */
  enqueue(normalized: string): void {
    if (!normalized) return;

    const current = this.queue.get(normalized) ?? 0;
    this.queue.set(normalized, current + 1);
    this.metrics.incrementSearchRequests();

    // Trigger flush if the queue has grown to batchSize unique queries
    if (this.queue.size >= this.batchSize) {
      void this.flush();
    }
  }

  /** Current number of distinct queries waiting in the queue. */
  getQueueDepth(): number {
    return this.queue.size;
  }

  // ─── Flush ────────────────────────────────────────────────────────────────

  /**
   * Flush the current queue to SQLite, update the trie and trending store,
   * and invalidate stale cache entries.
   *
   * Guards against re-entrant flushes (setInterval fires while a previous
   * flush is still I/O-bound on Redis invalidations).
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.size === 0) return;
    this.flushing = true;

    try {
      // ── 1. Snapshot the queue atomically and clear it ──────────────────
      // Node.js is single-threaded, so this is safe: no new enqueue() call
      // can interleave between the snapshot and the clear.
      const batch = new Map(this.queue);
      this.queue.clear();

      // ── 2. Compute metrics before writing ─────────────────────────────
      let totalSearchesInBatch = 0;
      for (const delta of batch.values()) totalSearchesInBatch += delta;
      const uniqueQueriesInBatch = batch.size;
      // writes avoided = total searches - distinct DB upserts
      this.metrics.addWritesAvoided(totalSearchesInBatch - uniqueQueriesInBatch);

      // ── 3. SQLite: batch-increment query counts ────────────────────────
      const newCounts = this.db.batchIncrementCounts(batch);
      this.metrics.addDbWrites(uniqueQueriesInBatch);
      this.metrics.incrementBatchFlushes();

      // ── 4. SQLite: persist trending buckets ───────────────────────────
      const currentHourBucket =
        Math.floor(Date.now() / 3_600_000) * 3_600_000;
      const trendingItems = [...batch.entries()].map(([normalized, delta]) => ({
        normalized,
        hourBucket: currentHourBucket,
        count: delta,
      }));
      this.db.batchUpsertTrendingBuckets(trendingItems);

      // ── 5. Update in-memory trie ───────────────────────────────────────
      for (const [normalized, delta] of batch) {
        this.trie.update(normalized, delta);
      }

      // ── 6. Update in-memory trending store ────────────────────────────
      for (const [normalized, delta] of batch) {
        this.trending.addSearchCount(normalized, currentHourBucket, delta);
      }

      // ── 7. Invalidate Redis cache for all affected prefixes ────────────
      // Run all invalidations concurrently.
      const invalidations = [...batch.keys()].map((normalized) =>
        this.hashRing.invalidatePrefixesForQuery(normalized),
      );
      await Promise.all(invalidations);
    } finally {
      this.flushing = false;
    }
  }
}
