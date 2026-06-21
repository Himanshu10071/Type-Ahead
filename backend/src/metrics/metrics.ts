/**
 * metrics.ts — Live counters and rolling p95 latency tracker.
 *
 * P95 implementation: rolling window of the last WINDOW_SIZE (1 000) request
 * latencies stored in a circular buffer.  Rationale for a fixed sample count
 * over a time-based window: time-based windows require continuous eviction
 * loops and timestamp bookkeeping; a fixed sample count is trivially correct,
 * statistically stable for services handling ≥ 100 RPS, and sufficient for
 * a demo.  The circular buffer avoids unbounded memory growth.
 */

export class Metrics {
  // ─── Raw counters ─────────────────────────────────────────────────────────
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _searchRequests = 0;
  private _dbReads = 0;
  private _dbWrites = 0;
  private _writesAvoided = 0;
  private _batchFlushes = 0;

  // ─── Rolling latency window ───────────────────────────────────────────────
  private static readonly WINDOW_SIZE = 1_000;
  private latencyBuffer: number[] = [];
  private latencyHead = 0; // next write position in the circular buffer
  private latencyFull = false; // has the buffer wrapped at least once?

  // ─── Increment helpers ────────────────────────────────────────────────────

  incrementCacheHit(): void {
    this._cacheHits++;
  }

  incrementCacheMiss(): void {
    this._cacheMisses++;
  }

  incrementSearchRequests(): void {
    this._searchRequests++;
  }

  incrementDbReads(): void {
    this._dbReads++;
  }

  addDbWrites(n: number): void {
    this._dbWrites += n;
  }

  addWritesAvoided(n: number): void {
    this._writesAvoided += n;
  }

  incrementBatchFlushes(): void {
    this._batchFlushes++;
  }

  // ─── Latency recording ────────────────────────────────────────────────────

  recordLatency(ms: number): void {
    if (this.latencyBuffer.length < Metrics.WINDOW_SIZE) {
      this.latencyBuffer.push(ms);
    } else {
      this.latencyFull = true;
      this.latencyBuffer[this.latencyHead] = ms;
    }
    this.latencyHead = (this.latencyHead + 1) % Metrics.WINDOW_SIZE;
  }

  // ─── Computed properties ──────────────────────────────────────────────────

  get cacheHits(): number {
    return this._cacheHits;
  }
  get cacheMisses(): number {
    return this._cacheMisses;
  }
  get searchRequests(): number {
    return this._searchRequests;
  }
  get dbReads(): number {
    return this._dbReads;
  }
  get dbWrites(): number {
    return this._dbWrites;
  }
  get writesAvoided(): number {
    return this._writesAvoided;
  }
  get batchFlushes(): number {
    return this._batchFlushes;
  }

  get cacheHitRate(): number {
    const total = this._cacheHits + this._cacheMisses;
    if (total === 0) return 0;
    return Math.round((this._cacheHits / total) * 10_000) / 10_000;
  }

  get p95LatencyMs(): number {
    if (this.latencyBuffer.length === 0) return 0;
    const sorted = [...this.latencyBuffer].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[idx];
  }

  /** Full snapshot suitable for the /metrics endpoint response. */
  snapshot(queueDepth: number): object {
    return {
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      cacheHitRate: this.cacheHitRate,
      searchRequests: this._searchRequests,
      dbReads: this._dbReads,
      dbWrites: this._dbWrites,
      writesAvoided: this._writesAvoided,
      batchFlushes: this._batchFlushes,
      queueDepth,
      p95LatencyMs: this.p95LatencyMs,
      latencySamples: this.latencyFull
        ? Metrics.WINDOW_SIZE
        : this.latencyBuffer.length,
    };
  }
}
