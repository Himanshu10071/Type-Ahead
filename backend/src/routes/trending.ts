/**
 * trending.ts — GET /trending
 *
 * Returns the top-N trending queries scored by:
 *   score = 0.7 × log10(total_count + 1) + 0.3 × recency_score
 *
 * The trending result is computed on-demand (no separate trending cache) by
 * iterating over the in-memory TrendingManager.  Computation is O(M) where
 * M is the number of distinct queried-in-last-24h terms (typically a few
 * thousand).  This runs in < 1 ms in practice.
 *
 * The all-time counts are fetched from the trie's root topK list and merged
 * with the full trending store so even low-frequency spiky queries are scored.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TrendingManager } from '../trending/trending';
import { DatabaseService } from '../db/database';
import { Trie } from '../trie/trie';

export function registerTrendingRoute(
  app: FastifyInstance,
  trending: TrendingManager,
  db: DatabaseService,
  trie: Trie,
  trendingN: number,
): void {
  app.get('/trending', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Build a count map from the trie root topK (covers the most popular queries).
    // For trending queries that may not be in the root topK, do a targeted lookup.
    const countMap = new Map<string, number>();

    // Get the database's in-memory projection by using the trie root topK
    // which contains the globally most searched queries.  For queries only in
    // the trending store (lower volume but recent), we fetch counts from SQLite.
    // In practice this is a very small additional query set.
    const trieTopAll = trie.search(''); // root node topK — global top-10
    for (const entry of trieTopAll) {
      countMap.set(entry.query, entry.count);
    }

    // Build a set of all normalised queries tracked by trending
    // We rely on the trie for counts since it mirrors SQLite.
    // For any trending query not in trie root topK, fetch from SQLite.
    const results = trending.getTrending(trendingN, countMap);

    // Enrich counts for queries that weren't in root topK
    const missing = results.filter((r) => !countMap.has(r.query));
    if (missing.length > 0) {
      const raw = db.getRaw();
      const stmt = raw.prepare('SELECT count FROM queries WHERE normalized = ?');
      for (const entry of missing) {
        const row = stmt.get(entry.query) as { count: number } | undefined;
        if (row) {
          entry.count = row.count;
        }
      }
    }

    return reply.send(results);
  });
}
