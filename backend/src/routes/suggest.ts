/**
 * suggest.ts — GET /suggest?q=<prefix>
 *
 * Cache-aside flow:
 *   1. Normalise prefix (lowercase, trim).
 *   2. Compute cache key = "suggest:<normalised-prefix>".
 *   3. Determine owning Redis node via consistent hash ring.
 *   4. Try Redis GET on that node.
 *   5. Hit  → return cached JSON array; record cache hit.
 *   6. Miss → query in-memory trie; write result back to Redis with TTL;
 *              return result; record cache miss + DB read.
 *
 * Latency is recorded for every request (cache hit or miss) so the /metrics
 * endpoint can report an accurate p95 across all code paths.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Trie, TopKEntry } from '../trie/trie';
import { ConsistentHashRing } from '../cache/consistentHash';
import { Metrics } from '../metrics/metrics';

interface SuggestQuery {
  q?: string;
}

export function registerSuggestRoute(
  app: FastifyInstance,
  trie: Trie,
  hashRing: ConsistentHashRing,
  metrics: Metrics,
  cacheTtlSeconds: number,
): void {
  app.get<{ Querystring: SuggestQuery }>(
    '/suggest',
    async (request: FastifyRequest<{ Querystring: SuggestQuery }>, reply: FastifyReply) => {
      const start = Date.now();

      const raw = request.query.q ?? '';
      const prefix = raw.trim().toLowerCase();

      // Spec: empty/whitespace-only q → return []
      if (!prefix) {
        metrics.recordLatency(Date.now() - start);
        return reply.send([]);
      }

      const cacheKey = `suggest:${prefix}`;

      // ── 1. Try cache ────────────────────────────────────────────────────
      const cached = await hashRing.get<TopKEntry[]>(cacheKey);
      if (cached !== null) {
        metrics.incrementCacheHit();
        metrics.recordLatency(Date.now() - start);
        return reply.send(cached);
      }

      // ── 2. Cache miss — query the in-memory trie ─────────────────────
      metrics.incrementCacheMiss();
      metrics.incrementDbReads(); // trie is the in-memory projection of the DB

      const results = trie.search(prefix);

      // ── 3. Populate cache for future requests ────────────────────────
      await hashRing.set(cacheKey, results, cacheTtlSeconds);

      metrics.recordLatency(Date.now() - start);
      return reply.send(results);
    },
  );
}
