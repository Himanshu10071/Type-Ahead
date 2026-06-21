# TypeAhead — Distributed Search Typeahead System

A production-quality, Google-style search typeahead system with:
- **Real-time suggestions** backed by an in-memory trie index (top-10 per prefix, O(1) read)
- **Distributed Redis cache** using consistent hashing across 3 nodes
- **Batch write pipeline** with aggregation and configurable flush triggers
- **Trending search analytics** with recency-aware scoring
- **React frontend** with debounced suggestions and keyboard navigation
- **Full observability** via `/metrics` and `/cache/debug` endpoints

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     React Frontend  (Vite · port 4173)                     │
│                                                                             │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │ SearchBar (debounce 200ms)  →  GET /suggest  →  SuggestionDropdown  │  │
│   │ Enter / click              →  POST /search   →  result banner       │  │
│   │ TrendingSection (30s poll) →  GET /trending                         │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ HTTP  (port 3001)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Fastify API Server  (Node.js · TypeScript)               │
│                                                                             │
│  GET /suggest ──► Consistent Hash Ring ──► Redis Node (cache-aside)        │
│                          │ cache miss                                       │
│                          ▼                                                  │
│               In-Memory Trie Index  ◄──── SQLite (startup load)            │
│                          │                                                  │
│                          └──► write result back to Redis (TTL 5 min)       │
│                                                                             │
│  POST /search ──► In-Memory Queue  ──► Batch Aggregator                    │
│                                             │ flush (size OR interval)      │
│                                             ▼                               │
│                                    SQLite UPSERT tx                         │
│                                        │     │                              │
│                                    trie  trending   cache invalidate        │
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                        │
│  │   Redis-1   │  │   Redis-2   │  │   Redis-3   │  ← consistent hash ring │
│  │  (port 6379)│  │  (port 6380)│  │  (port 6381)│    150 vnodes each      │
│  └─────────────┘  └─────────────┘  └─────────────┘                        │
│                                                                             │
│  SQLite (better-sqlite3, WAL mode) ─── source of truth                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Setup Instructions

### Prerequisites
- Node.js ≥ 18
- Docker + Docker Compose v2
- The dataset file `query_count.tsv` in the project root

### Local Development (no Docker)

```bash
# 1. Start Redis nodes locally
docker run -d -p 6379:6379 --name redis-1 redis:7-alpine
docker run -d -p 6380:6379 --name redis-2 redis:7-alpine
docker run -d -p 6381:6379 --name redis-3 redis:7-alpine

# 2. Install backend dependencies
cd backend
npm install

# 3. Ingest the dataset (run once; idempotent — safe to re-run)
npm run ingest                    # uses ../../query_count.tsv by default
# or specify custom paths:
npm run ingest /path/to/data.tsv /path/to/output.db

# 4. Start the backend
npm run dev                       # ts-node-dev with hot reload

# 5. In a separate terminal, install and start the frontend
cd frontend
npm install
npm run dev                       # Vite dev server at http://localhost:5173
```

### Docker Compose (full stack)

```bash
# From the project root:
docker compose up --build

# The backend must be pre-populated with data.
# Run ingestion against the mounted volume after the backend starts:
docker compose exec backend node dist/scripts/ingest.js /path/to/query_count.tsv

# Access the app:
#   Frontend:    http://localhost:4173
#   Backend API: http://localhost:3001
```

### Environment Variables

| Variable            | Default                    | Description                                      |
|---------------------|----------------------------|--------------------------------------------------|
| `PORT`              | `3001`                     | Fastify HTTP port                               |
| `DB_PATH`           | `./data/typeahead.db`      | SQLite database path                            |
| `BATCH_SIZE`        | `100`                      | Unique queries before forced flush              |
| `FLUSH_INTERVAL_MS` | `5000`                     | Max ms between flushes                          |
| `CACHE_TTL_SECONDS` | `300`                      | Redis key TTL (5 minutes)                       |
| `TOP_K`             | `10`                       | Suggestions returned per prefix                 |
| `TRENDING_N`        | `10`                       | Trending results returned                       |
| `RECENCY_SCALE`     | `10000`                    | Normalisation constant for recency scoring      |
| `REDIS_HOST_1`      | `localhost`                | Redis node 1 hostname                           |
| `REDIS_PORT_1`      | `6379`                     | Redis node 1 port                               |
| `REDIS_HOST_2`      | `localhost`                | Redis node 2 hostname                           |
| `REDIS_PORT_2`      | `6380`                     | Redis node 2 port                               |
| `REDIS_HOST_3`      | `localhost`                | Redis node 3 hostname                           |
| `REDIS_PORT_3`      | `6381`                     | Redis node 3 port                               |

---

## 3. API Documentation

### `GET /suggest?q=<prefix>`

Returns the top-10 suggestions matching the given prefix, sorted by count descending.

- **Case-insensitive** — `q` is lowercased before lookup.
- **Empty or whitespace `q`** → returns `[]` (not an error).
- **No matches** → returns `[]`.

**Response (200):**
```json
[
  { "query": "suzanne steinbaum", "count": 78263 },
  { "query": "suzanne", "count": 42100 }
]
```

---

### `POST /search`

Records a search query for batch processing. **Does not write to SQLite directly.**

**Request:**
```json
{ "query": "suzanne steinbaum" }
```

**Response (200):**
```json
{ "message": "searched" }
```

**Error (400):** If `query` is missing or empty.

---

### `GET /trending`

Returns the top-10 trending queries ranked by the scoring formula.

**Response (200):**
```json
[
  {
    "query": "iphone 16",
    "score": 2.847,
    "count": 15230,
    "recencyScore": 0.912
  }
]
```

---

### `GET /cache/debug?prefix=<prefix>`

Introspects the consistent hash ring for a given prefix.

**Response (200):**
```json
{
  "prefix": "suz",
  "key": "suggest:suz",
  "hash": 3054789123,
  "cacheNode": "redis-2",
  "cacheHit": true
}
```

**Error (400):** If `prefix` is missing.

---

### `GET /metrics`

Live operational counters.

**Response (200):**
```json
{
  "cacheHits": 1042,
  "cacheMisses": 287,
  "cacheHitRate": 0.7842,
  "searchRequests": 534,
  "dbReads": 287,
  "dbWrites": 89,
  "writesAvoided": 445,
  "batchFlushes": 11,
  "queueDepth": 3,
  "p95LatencyMs": 4,
  "latencySamples": 1000
}
```

---

### `GET /health`

Liveness check used by Docker healthchecks.

**Response (200):**
```json
{ "status": "ok", "uptime": 123.4 }
```

---

## 4. Database Schema

```sql
-- Queries table — source of truth for all-time search counts
CREATE TABLE queries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  query      TEXT    NOT NULL,           -- original casing (display)
  normalized TEXT    NOT NULL UNIQUE,    -- lowercase + trimmed (indexing)
  count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_normalized ON queries (normalized);

-- Trending buckets — hourly activity for recency scoring
CREATE TABLE trending_buckets (
  normalized  TEXT    NOT NULL,
  hour_bucket INTEGER NOT NULL,  -- Unix epoch ms, floored to hour
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (normalized, hour_bucket)
);
```

**WAL mode** is enabled (`PRAGMA journal_mode = WAL`) for concurrent read performance.

---

## 5. Consistent Hashing

### How it works

The system maintains a **hash ring** — a sorted circular array of 450 virtual nodes (150 per physical Redis node). Each virtual node is assigned a position on the ring by hashing the string `"<nodeName>:vnode:<i>"` using **MD5**, then taking the first 32 bits as a uint32.

**Hash function choice — MD5:**
- Available in Node.js `crypto` without native addons (murmur3 requires `murmurhash-native`)
- Excellent distribution for hash-ring purposes
- Cryptographic strength is irrelevant here

**Node lookup:**
Given a cache key `suggest:<prefix>`:
1. Compute `hash = MD5("suggest:<prefix>")[0..7] as uint32`
2. Binary-search the sorted ring for the first virtual node with `vnode.hash >= hash`
3. If no such node exists (wrap-around), use the first node on the ring

**Virtual nodes — why 150?**
- Distribution uniformity: standard deviation of load ≈ `1/√(vnodes × N)` ≈ 3.7%
- Memory cost: 450 entries × ~40 bytes ≈ 18 KB — negligible
- Minimal remapping: adding/removing one node only remaps ≈ 1/3 of keys

### Cache key format

```
suggest:<normalized-prefix>
```

Example: `suggest:suz` → MD5 → uint32 → ring lookup → `redis-2`

---

## 6. Batch Write Pipeline

```
POST /search
    │
    ▼  (O(1), synchronous, in-memory only)
Map<normalized, delta>   ← aggregation
    │
    ▼  (flush trigger: size ≥ BATCH_SIZE  OR  FLUSH_INTERVAL_MS elapsed)
Single SQLite UPSERT transaction
    ├── Update query counts (INSERT … ON CONFLICT DO UPDATE SET count = count + delta)
    └── Update trending_buckets
    │
    ├── Update in-memory trie (trie.update per unique query)
    ├── Update in-memory trending store
    └── Invalidate Redis cache keys (all prefixes of each updated query)
```

**Aggregation example:**
- Batch receives: `iphone×3`, `java×1`, `iphone×2`
- Queue aggregates to: `{ iphone: 5, java: 1 }`
- Result: 2 DB writes instead of 6; `writesAvoided = 4`

### Crash / Durability Tradeoff

The in-memory queue is **lost on process crash** (at-most-once delivery). For a typeahead system, losing a few search count increments is acceptable — the data is statistical, not transactional.

**Durability options (not implemented):**

| Option | Approach | Cost |
|--------|----------|------|
| WAL file | Append each POST to a local log file before enqueuing; replay on restart | ~1 ms disk I/O per request |
| Redis Stream | Push each query to a Redis Stream (durable log); consumer group with ACK | Requires Redis AOF/RDB persistence |
| Kafka/Pulsar | Full message queue with replication | Significant operational overhead |

This implementation accepts the at-most-once tradeoff because: (1) count accuracy is best-effort, (2) typical flush intervals are ≤5 s so worst-case loss is small, (3) the simplicity benefit is substantial.

---

## 7. Trending Algorithm

### Scoring Formula

```
score = 0.7 × log₁₀(total_count + 1)  +  0.3 × recency_score

recency_score = tanh(weighted_sum / RECENCY_SCALE)

weighted_sum = Σ_{h=0}^{23} bucket_count[h] × (h + 1)
```

Where:
- `h = 0` → 23 hours ago (weight 1)
- `h = 23` → current hour (weight 24)
- `RECENCY_SCALE = 10 000` (configurable)
- `tanh(·)` maps [0, ∞) → [0, 1) ensuring recency_score is always bounded

### Bucket Lifecycle

- **Granularity:** 1-hour buckets keyed by `Math.floor(Date.now() / 3_600_000) * 3_600_000`
- **Retention:** Last 24 buckets (24 hours)
- **Eviction:** Lazy — stale buckets are removed when a new search arrives for that query (no background timer needed)
- **Persistence:** Buckets are written to SQLite on each batch flush and restored on startup

### Ranking Rationale

| Scenario | score behavior |
|----------|---------------|
| High-volume, stale query ("christmas gifts" in June) | High log-count term, near-zero recency → moderate score |
| Low-volume, spiking query (breaking news) | Low log-count term, high recency → can still surface |
| All-time popular + recent (active trending) | Both terms high → dominates the list |

**Why log₁₀?** Raw counts let a 10M-search query score 10,000× higher than a 1K-search query. `log₁₀(10M) ≈ 7` vs `log₁₀(1K) ≈ 3` — only 2.3× higher — preserving competitive ranking for emerging queries.

**Why 70/30?** Popularity is a stronger signal than a single-hour spike; 70% weight prevents viral noise from displacing genuine trends.

### Cache Invalidation

The trending result is **computed on-demand** from the in-memory store (O(M) where M = distinct tracked queries, typically a few thousand). No separate trending cache is needed — computation takes < 1 ms.

---

## 8. Cache Strategy

### Cache-Aside Flow

```
GET /suggest?q=<prefix>
        │
        ▼
cacheKey = "suggest:<normalised_prefix>"
        │
        ▼
hash ring → Redis node
        │
        ├── HIT  → parse JSON → return to client → record cacheHit
        │
        └── MISS → query trie → write to Redis (TTL 5 min)
                            → return to client → record cacheMiss
```

### TTL

5 minutes (300 seconds, configurable via `CACHE_TTL_SECONDS`). After 5 minutes a prefix key expires automatically so stale suggestions don't persist indefinitely.

### Invalidation on Writes

After each batch flush, for every updated query `q` with length `L`, the system deletes cache keys:
```
suggest:q[0..1], suggest:q[0..2], ..., suggest:q[0..L]
```
These deletions run concurrently (Promise.all). On the next request for any of these prefixes, the cache is repopulated from the fresh trie.

---

## 9. Failure Scenarios

| Scenario | System behaviour |
|----------|-----------------|
| **Redis node down** | `ConsistentHashRing.get()` / `set()` / `del()` catch all errors silently. The affected prefixes always fall through to the trie. Cache hit rate drops for keys that mapped to the downed node; everything else is unaffected. No data loss. |
| **Backend crash mid-batch** | Searches in the in-memory queue since the last flush are lost (at-most-once). The SQLite database is consistent — WAL mode ensures no partial writes survive a crash. The trie is rebuilt from SQLite on restart. Redis cache remains valid (it holds the pre-crash state). |
| **Malformed ingestion rows** | The ingest script skips malformed rows (missing tab, empty query, non-numeric count) and logs each category with its count. Well-formed rows are unaffected. |
| **SQLite write error during flush** | The batch writer logs the error. The in-memory trie and Redis are NOT updated (consistency preserved — both will reflect pre-flush state). The queue has already been cleared; those increments are lost for this flush cycle. |
| **Trie out of sync after restart** | Never happens — the trie is always rebuilt from SQLite on startup, so it always reflects the durable state. |

---

## 10. Performance Discussion

### Expected Latency at Each Layer

| Layer | Typical latency | Notes |
|-------|----------------|-------|
| Trie lookup (cache miss) | < 0.1 ms | Pure in-memory, O(prefix_len) |
| Redis GET (cache hit) | 0.5–2 ms | Network RTT within Docker bridge |
| SQLite read (fallback) | < 1 ms | WAL mode, memory-mapped pages |
| Batch flush (SQLite write) | 5–50 ms | Amortised across all queries in batch |

### Bottlenecks

1. **Trie build time on startup** — 500K entries take ~5–10 seconds. Mitigation: use a startup probe before routing traffic (Docker healthcheck with 30s start_period).
2. **Redis round-trip** — Each suggest request makes one Redis GET. At 1000 RPS this is 1000 TCP round-trips/s per node. Mitigation: Redis pipelining or a local in-process LRU cache for the hottest prefixes.
3. **Cache invalidation fan-out** — A 20-char query triggers 20 Redis DEL operations per flush. For 100 unique queries per batch that's 2000 DEL calls. Mitigation: batch DEL with UNLINK (async), or use tag-based invalidation.

### Scaling Further

| Change | Impact |
|--------|--------|
| Add Redis nodes | Scales read throughput linearly; consistent hashing ensures minimal remapping |
| Multiple Fastify instances | Stateless except for the trie; share trie via shared memory or move it to a sidecar service |
| Replace SQLite with PostgreSQL | Enables multi-process writes; add `pg` adapter behind the same `DatabaseService` interface |
| Add local process LRU cache | Eliminate Redis for the top-1000 most-queried prefixes; add a small `lru-cache` per instance |
| Move batch queue to Redis Streams | Durability for searches across crashes; consumers in a consumer group |
