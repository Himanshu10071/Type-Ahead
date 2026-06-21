#!/usr/bin/env ts-node
/**
 * ingest.ts — Dataset ingestion script.
 *
 * Usage:
 *   npm run ingest [<tsv-path>] [<db-path>]
 *
 * Defaults:
 *   tsv-path = ../../query_count.tsv  (relative to this script's location)
 *   db-path  = ../data/typeahead.db
 *
 * Input format (tab-separated values, no header):
 *   <query>\t<count>
 *
 * What this script does:
 *   1. Opens the TSV line-by-line (streaming — avoids loading 500 MB into RAM).
 *   2. Validates each row: must have exactly one tab, numeric count > 0, non-empty query.
 *   3. Normalises the query: lowercases + trims for the `normalized` column;
 *      original casing is preserved in the `query` column for display.
 *   4. Accumulates rows into chunks of CHUNK_SIZE.
 *   5. Bulk-upserts each chunk in a single SQLite transaction (idempotent ON CONFLICT).
 *   6. Logs a summary of processed / skipped rows at the end.
 *
 * Idempotency:
 *   Uses INSERT … ON CONFLICT(normalized) DO UPDATE SET count = MAX(...)
 *   so re-running the script never duplicates rows.  If the same normalised
 *   query appears multiple times in the TSV, the row with the higher count wins.
 *
 * Performance:
 *   Chunked transactions of 1 000 rows each avoid the overhead of one
 *   SQLite transaction per row while also preventing a single transaction
 *   spanning 500 K rows (which would hold the write lock too long).
 */

import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { DatabaseService } from '../src/db/database';

const CHUNK_SIZE = 1_000;

interface SkipReason {
  reason: string;
  count: number;
}

async function ingest(): Promise<void> {
  // Default TSV path: <project-root>/query_count.tsv
  // When compiled, __dirname = dist/scripts/ → resolve 3 levels up → project root
  const tsvPath = process.argv[2] ?? path.resolve(__dirname, '../../../query_count.tsv');
  // Default DB path: backend/data/typeahead.db
  const dbPath = process.argv[3] ?? path.resolve(__dirname, '../../data/typeahead.db');

  console.log(`[ingest] TSV source : ${tsvPath}`);
  console.log(`[ingest] SQLite db  : ${dbPath}`);

  if (!fs.existsSync(tsvPath)) {
    console.error(`[ingest] ERROR: TSV file not found at ${tsvPath}`);
    console.error('[ingest] Pass the path as the first argument: npm run ingest <path>');
    process.exit(1);
  }

  const db = new DatabaseService(dbPath);

  const skipReasons: Map<string, number> = new Map();
  let totalLines = 0;
  let skipped = 0;
  let processed = 0;

  const chunk: Array<{ query: string; normalized: string; count: number }> = [];

  const flush = (): void => {
    if (chunk.length === 0) return;
    db.bulkUpsertQueries([...chunk]);
    processed += chunk.length;
    chunk.length = 0;
    if (processed % 50_000 === 0) {
      console.log(`[ingest] Processed ${processed} rows…`);
    }
  };

  const addSkip = (reason: string): void => {
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    skipped++;
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(tsvPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    totalLines++;

    // Skip blank lines (common at end of file)
    if (line.trim() === '') {
      addSkip('blank line');
      continue;
    }

    const tabIdx = line.indexOf('\t');

    // Must have exactly one tab separating query and count
    if (tabIdx === -1) {
      addSkip('missing tab separator');
      continue;
    }

    const rawQuery = line.slice(0, tabIdx);
    const rawCount = line.slice(tabIdx + 1).trim();

    // Query must be non-empty after trimming
    const trimmedQuery = rawQuery.trim();
    if (!trimmedQuery) {
      addSkip('empty query');
      continue;
    }

    // Count must be a valid positive integer
    const count = parseInt(rawCount, 10);
    if (isNaN(count) || String(count) !== rawCount || count <= 0) {
      addSkip(`non-numeric or non-positive count ("${rawCount}")`);
      continue;
    }

    const normalized = trimmedQuery.toLowerCase();

    chunk.push({ query: trimmedQuery, normalized, count });

    if (chunk.length >= CHUNK_SIZE) {
      flush();
    }
  }

  // Flush remaining rows
  flush();

  console.log('\n══════════════════════════════════════════');
  console.log('[ingest] Ingestion complete');
  console.log(`  Total lines read : ${totalLines}`);
  console.log(`  Rows inserted    : ${processed}`);
  console.log(`  Rows skipped     : ${skipped}`);
  if (skipped > 0) {
    console.log('\n  Skip breakdown:');
    for (const [reason, count] of skipReasons) {
      console.log(`    • ${reason}: ${count}`);
    }
  }
  console.log('══════════════════════════════════════════\n');

  db.close();
}

ingest().catch((err) => {
  console.error('[ingest] Fatal error:', err);
  process.exit(1);
});
