/**
 * index.ts — Fastify server entry point.
 *
 * Startup sequence:
 *   1. Open SQLite database, apply schema.
 *   2. Load all queries from SQLite and build the in-memory trie.
 *   3. Build the consistent hash ring and connect to Redis nodes.
 *   4. Restore trending buckets from SQLite into the in-memory store.
 *   5. Initialise metrics and batch writer.
 *   6. Register all routes.
 *   7. Start the HTTP server.
 *
 * Shutdown:
 *   On SIGINT / SIGTERM, the batch writer flushes remaining queue entries
 *   to SQLite before the process exits.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import { DatabaseService } from './db/database';
import { Trie } from './trie/trie';
import { ConsistentHashRing } from './cache/consistentHash';
import { BatchWriter } from './batch/batchWriter';
import { TrendingManager } from './trending/trending';
import { Metrics } from './metrics/metrics';
import { registerSuggestRoute } from './routes/suggest';
import { registerSearchRoute } from './routes/search';
import { registerTrendingRoute } from './routes/trending';
import { registerCacheDebugRoute } from './routes/cacheDebug';
import { registerMetricsRoute } from './routes/metrics';

const app = Fastify({ logger: { level: 'info' } });

async function main(): Promise<void> {
  // ── 1. Database ────────────────────────────────────────────────────────────
  console.log(`[startup] Opening SQLite at ${config.dbPath}`);
  const db = new DatabaseService(config.dbPath);
  const rowCount = db.getQueryCount();
  console.log(`[startup] SQLite has ${rowCount} query rows.`);

  // ── 2. Build in-memory trie ────────────────────────────────────────────────
  console.log('[startup] Building trie index (this may take a few seconds for large datasets)…');
  const trie = new Trie(config.topK);
  let loaded = 0;
  for (const row of db.iterateAllQueries()) {
    trie.insert(row.normalized, row.count);
    if (++loaded % 50_000 === 0) {
      console.log(`[startup] Trie: loaded ${loaded} / ${rowCount} entries`);
    }
  }
  console.log(`[startup] Trie built with ${loaded} entries.`);

  // ── 3. Consistent hash ring + Redis ───────────────────────────────────────
  console.log('[startup] Initialising Redis consistent hash ring…');
  const hashRing = new ConsistentHashRing(config.redis.nodes);

  // ── 4. Trending manager — restore from SQLite ─────────────────────────────
  const trending = new TrendingManager(config.recencyScale);
  const trendingBuckets = db.getRecentTrendingBuckets();
  for (const row of trendingBuckets) {
    trending.loadBucket(row.normalized, row.hour_bucket, row.count);
  }
  console.log(
    `[startup] Trending restored — tracking ${trending.trackedQueryCount} queries.`,
  );

  // ── 5. Metrics + batch writer ──────────────────────────────────────────────
  const metrics = new Metrics();
  const batchWriter = new BatchWriter(
    db,
    trie,
    hashRing,
    trending,
    metrics,
    config.batchSize,
    config.flushIntervalMs,
    config.cacheTtlSeconds,
  );
  batchWriter.start();

  // ── 6. Register routes ────────────────────────────────────────────────────
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] });

  registerSuggestRoute(app, trie, hashRing, metrics, config.cacheTtlSeconds);
  registerSearchRoute(app, batchWriter);
  registerTrendingRoute(app, trending, db, trie, config.trendingN);
  registerCacheDebugRoute(app, hashRing);
  registerMetricsRoute(app, metrics, batchWriter);

  // Health check
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // ── 7. Start HTTP server ───────────────────────────────────────────────────
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[startup] Server listening on port ${config.port}`);

  // ── 8. Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[shutdown] Received ${signal}. Flushing batch queue…`);
    await batchWriter.stop();
    await hashRing.disconnect();
    db.close();
    console.log('[shutdown] Clean exit.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});
