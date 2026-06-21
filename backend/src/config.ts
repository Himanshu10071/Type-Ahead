/**
 * config.ts — Centralised configuration loaded from environment variables.
 * All values have sane defaults so the server starts without any .env file.
 */
export const config = {
  /** Fastify HTTP port */
  port: Number(process.env.PORT ?? 3001),

  /** SQLite database file path */
  dbPath: process.env.DB_PATH ?? './data/typeahead.db',

  /** Maximum queries held in the in-memory batch queue before a forced flush */
  batchSize: Number(process.env.BATCH_SIZE ?? 100),

  /** Flush the batch queue on this interval (ms), even if batchSize is not hit */
  flushIntervalMs: Number(process.env.FLUSH_INTERVAL_MS ?? 5_000),

  /** Redis cache TTL for suggest keys (seconds) */
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 300),

  /** Number of top results returned per prefix node in the trie */
  topK: Number(process.env.TOP_K ?? 10),

  /** Number of trending results returned */
  trendingN: Number(process.env.TRENDING_N ?? 10),

  /**
   * Trending recency normalisation scale.
   * recency_score = tanh(weighted_hourly_sum / RECENCY_SCALE)
   * A value of 10 000 means ~10 000 weighted-count units saturates the score at ~1.
   */
  recencyScale: Number(process.env.RECENCY_SCALE ?? 10_000),

  /** Redis node definitions (3 nodes for the consistent-hash ring) */
  redis: {
    nodes: [
      {
        name: 'redis-1',
        host: process.env.REDIS_HOST_1 ?? 'localhost',
        port: Number(process.env.REDIS_PORT_1 ?? 6379),
      },
      {
        name: 'redis-2',
        host: process.env.REDIS_HOST_2 ?? 'localhost',
        port: Number(process.env.REDIS_PORT_2 ?? 6380),
      },
      {
        name: 'redis-3',
        host: process.env.REDIS_HOST_3 ?? 'localhost',
        port: Number(process.env.REDIS_PORT_3 ?? 6381),
      },
    ],
  },
};

export type Config = typeof config;
