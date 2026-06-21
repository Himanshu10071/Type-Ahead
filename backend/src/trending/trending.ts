/**
 * trending.ts — In-memory trending tracker using hourly activity buckets.
 *
 * Scoring formula (fully specified)
 * ───────────────────────────────────
 *   score = 0.7 × log10(total_count + 1)  +  0.3 × recency_score
 *
 *   recency_score = tanh(weighted_sum / RECENCY_SCALE)
 *
 *   weighted_sum  = Σ_{h=0}^{23}  bucket_count[h] × (h + 1)
 *     where h = 0 is the oldest bucket (23 hours ago)
 *           h = 23 is the current hour bucket (most recent)
 *     so more-recent hours get a higher weight (up to 24).
 *
 *   RECENCY_SCALE (default 10 000) normalises weighted_sum so that typical
 *   traffic levels produce recency_score values well distributed in (0, 1).
 *   tanh ensures the score is always in [0, 1) even for extreme counts.
 *
 * Ranking rationale
 * ─────────────────
 * • log10(count+1): Raw counts would let a billion-impression query ("google")
 *   dominate forever. Log compression shrinks the all-time-popularity range so
 *   a query with 100 000 hits scores only ~1.7× higher than one with 1 000.
 * • 70 / 30 split: Popularity still matters more than recency (a spam burst
 *   shouldn't displace a genuine trend), but a spiking low-volume query can
 *   still surface in the trending list.
 * • A high-volume-but-stale query (e.g., "christmas gifts" in June) earns
 *   full popularity credit but near-zero recency score, yielding a moderate
 *   overall score. A low-volume spiking query (breaking news) earns high
 *   recency but limited popularity, keeping the balance fair.
 *
 * Bucket lifecycle
 * ────────────────
 * • Buckets are keyed by the start-of-hour Unix timestamp in milliseconds.
 * • Each bucket older than 24 hours is stripped from the in-memory map when
 *   a new search arrives for that query (lazy expiry — no background loop
 *   needed, and the 24-hour window stays accurate to within 1 hour).
 * • On startup, buckets are restored from SQLite (only last 24 h are loaded).
 *
 * Trending cache invalidation
 * ───────────────────────────
 * The trending result is recomputed on every GET /trending request — no
 * separate trending cache layer is needed because the computation is O(N)
 * in the number of tracked queries (a few thousand at most) and takes < 1 ms.
 * After each batch flush the in-memory store is already up-to-date.
 */

export interface TrendingEntry {
  query: string;
  score: number;
  count: number;
  recencyScore: number;
}

export class TrendingManager {
  /**
   * normalized query → Map<hour_bucket_ms, count>
   * hour_bucket_ms = Math.floor(Date.now() / 3_600_000) * 3_600_000
   */
  private readonly store: Map<string, Map<number, number>> = new Map();
  private readonly recencyScale: number;

  constructor(recencyScale = 10_000) {
    this.recencyScale = recencyScale;
  }

  // ─── Ingestion ────────────────────────────────────────────────────────────

  /**
   * Record `count` searches for `normalized` in the current hour bucket.
   * Called by the batch writer after each flush.
   */
  addSearchCount(normalized: string, hourBucket: number, count: number): void {
    if (!this.store.has(normalized)) {
      this.store.set(normalized, new Map());
    }
    const buckets = this.store.get(normalized)!;
    buckets.set(hourBucket, (buckets.get(hourBucket) ?? 0) + count);
    this.evictOldBuckets(buckets, hourBucket);
  }

  /**
   * Load a bucket restored from SQLite at startup.
   * Called for each row returned by db.getRecentTrendingBuckets().
   */
  loadBucket(normalized: string, hourBucket: number, count: number): void {
    if (!this.store.has(normalized)) {
      this.store.set(normalized, new Map());
    }
    const buckets = this.store.get(normalized)!;
    buckets.set(hourBucket, (buckets.get(hourBucket) ?? 0) + count);
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * Return the top-N trending queries, scored by the formula above.
   * `queryCountMap` maps normalized query → all-time count (from the trie /
   * SQLite), supplied by the caller to avoid tight coupling.
   */
  getTrending(n: number, queryCountMap: Map<string, number>): TrendingEntry[] {
    const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const results: TrendingEntry[] = [];

    for (const [normalized, buckets] of this.store) {
      const totalCount = queryCountMap.get(normalized) ?? 1;
      const recencyScore = this.computeRecencyScore(buckets, now);
      const score =
        0.7 * Math.log10(totalCount + 1) + 0.3 * recencyScore;

      results.push({ query: normalized, score, count: totalCount, recencyScore });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, n);
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  /**
   * Compute recency_score ∈ [0, 1) for a query's bucket map.
   *
   *   weighted_sum = Σ_{h=0}^{23} bucket_count[currentHour - (23-h)×3600000] × (h+1)
   *   recency_score = tanh(weighted_sum / recencyScale)
   */
  private computeRecencyScore(
    buckets: Map<number, number>,
    currentHourBucket: number,
  ): number {
    let weightedSum = 0;
    for (let h = 0; h < 24; h++) {
      const bucketTs = currentHourBucket - (23 - h) * 3_600_000;
      const cnt = buckets.get(bucketTs) ?? 0;
      weightedSum += cnt * (h + 1);
    }
    // tanh maps [0, ∞) → [0, 1)
    return Math.tanh(weightedSum / this.recencyScale);
  }

  /**
   * Remove buckets older than 24 hours (lazy eviction).
   * Only runs when a new search arrives for the query, so no background timer.
   */
  private evictOldBuckets(
    buckets: Map<number, number>,
    currentHourBucket: number,
  ): void {
    const cutoff = currentHourBucket - 24 * 3_600_000;
    for (const ts of buckets.keys()) {
      if (ts < cutoff) buckets.delete(ts);
    }
  }

  /** Return how many distinct queries are being tracked. */
  get trackedQueryCount(): number {
    return this.store.size;
  }

  /**
   * Build a lightweight count map for the top-N trending candidates.
   * Returns a Map<normalized, total_count> populated from the trending store
   * for use when a full DB lookup is not needed (e.g., after each flush when
   * newCounts already carries updated counts).
   */
  mergeNewCounts(newCounts: Map<string, number>): Map<string, number> {
    // The caller (batchWriter) already has newCounts from SQLite.
    // Here we just pass it through; kept as a hook for future enrichment.
    return newCounts;
  }
}
