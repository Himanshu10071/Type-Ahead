/**
 * cacheDebug.ts — GET /cache/debug?prefix=<prefix>
 *
 * Exposes the internals of the consistent hashing ring for a given prefix,
 * including the computed hash, which Redis node owns the key, and whether
 * the key is currently cached (hit/miss).
 *
 * Response:
 *   {
 *     "prefix":    "suz",
 *     "key":       "suggest:suz",
 *     "hash":      1234567890,
 *     "cacheNode": "redis-2",
 *     "cacheHit":  true
 *   }
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ConsistentHashRing } from '../cache/consistentHash';

interface CacheDebugQuery {
  prefix?: string;
}

export function registerCacheDebugRoute(
  app: FastifyInstance,
  hashRing: ConsistentHashRing,
): void {
  app.get<{ Querystring: CacheDebugQuery }>(
    '/cache/debug',
    async (
      request: FastifyRequest<{ Querystring: CacheDebugQuery }>,
      reply: FastifyReply,
    ) => {
      const raw = request.query.prefix ?? '';
      const prefix = raw.trim().toLowerCase();

      if (!prefix) {
        return reply.status(400).send({
          error: 'prefix query parameter is required',
        });
      }

      const cacheKey = `suggest:${prefix}`;
      const info = hashRing.debugInfo(cacheKey);
      const cacheHit = await hashRing.exists(cacheKey);

      return reply.send({
        prefix,
        key: cacheKey,
        hash: info.hash,
        cacheNode: info.cacheNode,
        cacheHit,
      });
    },
  );
}
