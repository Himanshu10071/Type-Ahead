/**
 * consistentHash.ts — MD5-based consistent hashing ring with virtual nodes.
 *
 * Design decisions
 * ────────────────
 * Hash function: MD5 via Node's built-in `crypto` module.
 *   • No native addons required (murmur3 needs `murmurhash-native` or similar).
 *   • Cryptographic strength is irrelevant here; MD5's distribution is
 *     excellent for hash-ring purposes.
 *   • Each key is hashed to a 32-bit unsigned integer (first 8 hex digits).
 *
 * Virtual nodes: 150 per physical node (450 points on the ring total).
 *   • 150 is a widely-used industry heuristic that balances:
 *     – Distribution uniformity (std-dev of load ≈ 1/√(V·N) ≈ 3.7%)
 *     – Memory overhead (450 × 16 bytes ≈ 7 KB — negligible)
 *   • Adding or removing a node remaps ~1/N ≈ 33% of keys (only those that
 *     were assigned to that node's virtual slots), leaving the rest untouched.
 *
 * Node lookup: binary search on a sorted array of virtual-node hashes.
 *   O(log V) = O(log 450) ≈ 9 comparisons per lookup.
 *
 * Cache-aside helpers:
 *   get(key) — try the owning Redis node, return parsed JSON or null
 *   set(key, value, ttlSeconds) — write to owning Redis node
 *   del(key) — delete from owning Redis node
 *   invalidatePrefixesForQuery(normalized) — delete all prefix keys of a query
 */

import { createHash } from 'crypto';
import Redis from 'ioredis';

export interface RedisNodeConfig {
  name: string;
  host: string;
  port: number;
}

interface VirtualNode {
  hash: number;
  nodeName: string;
}

export interface NodeDebugInfo {
  cacheNode: string;
  hash: number;
  key: string;
}

export class ConsistentHashRing {
  private readonly ring: VirtualNode[] = [];
  private readonly clients: Map<string, Redis> = new Map();
  private readonly VNODES_PER_NODE = 150;

  constructor(nodes: RedisNodeConfig[]) {
    for (const node of nodes) {
      const client = new Redis({
        host: node.host,
        port: node.port,
        lazyConnect: true,
        enableReadyCheck: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
      });
      // Attach a no-op error handler to prevent "Unhandled error event" noise
      // when Redis is unavailable (e.g. local dev without Docker).
      // All actual errors are handled by try/catch in get() / set() / del().
      client.on('error', () => { /* intentionally silent */ });
      this.clients.set(node.name, client);

      for (let i = 0; i < this.VNODES_PER_NODE; i++) {
        const hash = this.md5ToUint32(`${node.name}:vnode:${i}`);
        this.ring.push({ hash, nodeName: node.name });
      }
    }

    // Sort the ring by hash value (clockwise order)
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  // ─── Hash ring mechanics ─────────────────────────────────────────────────

  private md5ToUint32(key: string): number {
    const hex = createHash('md5').update(key).digest('hex');
    // Take the first 8 hex characters → 32-bit unsigned integer
    return parseInt(hex.slice(0, 8), 16) >>> 0;
  }

  /**
   * Given a cache key, find the name of the owning Redis node.
   * Walks the ring clockwise (binary search) to the nearest vnode ≥ hash(key).
   * Wraps around to index 0 if the key hash exceeds all vnode hashes.
   */
  getNodeName(key: string): string {
    const keyHash = this.md5ToUint32(key);
    let lo = 0;
    let hi = this.ring.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].hash < keyHash) lo = mid + 1;
      else hi = mid;
    }

    const idx = lo === this.ring.length ? 0 : lo;
    return this.ring[idx].nodeName;
  }

  /** Return the raw uint32 hash for a key (used by the debug endpoint). */
  getKeyHash(key: string): number {
    return this.md5ToUint32(key);
  }

  /** Debug metadata for /cache/debug endpoint. */
  debugInfo(key: string): NodeDebugInfo {
    return {
      key,
      hash: this.getKeyHash(key),
      cacheNode: this.getNodeName(key),
    };
  }

  // ─── Redis client access ─────────────────────────────────────────────────

  getClient(key: string): Redis {
    const name = this.getNodeName(key);
    return this.clients.get(name)!;
  }

  getClientByName(name: string): Redis | undefined {
    return this.clients.get(name);
  }

  getAllClients(): Array<{ name: string; client: Redis }> {
    return [...this.clients.entries()].map(([name, client]) => ({ name, client }));
  }

  // ─── Cache-aside helpers ─────────────────────────────────────────────────

  /**
   * Get a cached value.  Returns null on cache miss or Redis error (graceful
   * degradation — the system falls back to the trie on any Redis failure).
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.getClient(key).get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /**
   * Set a cached value with a TTL.  Silently ignores Redis errors so a
   * degraded cache never blocks the API response.
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.getClient(key).setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      // Graceful degradation — cache unavailable
    }
  }

  /**
   * Check whether a key exists in cache and return hit status.
   * Used by /cache/debug for explicit hit/miss reporting.
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.getClient(key).exists(key);
      return result === 1;
    } catch {
      return false;
    }
  }

  /**
   * Invalidate all prefix cache keys for a given normalized query.
   *
   * When a query's count changes after a batch flush, every prefix of that
   * query (e.g. "i", "ip", "iph", …, "iphone") may have a stale cached
   * suggestion list.  All such keys are deleted concurrently.
   *
   * Cost: O(|query|) Redis DEL operations, executed in parallel.
   */
  async invalidatePrefixesForQuery(normalized: string): Promise<void> {
    const delPromises: Promise<void>[] = [];
    for (let i = 1; i <= normalized.length; i++) {
      const prefix = normalized.slice(0, i);
      const cacheKey = `suggest:${prefix}`;
      const client = this.getClient(cacheKey);
      delPromises.push(
        client.del(cacheKey).then(() => undefined).catch(() => undefined),
      );
    }
    await Promise.all(delPromises);
  }

  /** Gracefully disconnect all Redis clients. */
  async disconnect(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map((c) =>
        c.quit().catch(() => undefined),
      ),
    );
  }
}
