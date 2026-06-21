/**
 * trie.ts — In-memory prefix trie with precomputed top-K per node.
 *
 * Design rationale vs. alternatives
 * ──────────────────────────────────
 * Alternative A — Sorted array + binary search:
 *   Lookup O(log N) to find the prefix range start, then O(range_size) to
 *   scan for top-K. For a common 2-letter prefix like "st", range_size can
 *   be tens of thousands — unacceptable at P99.
 *
 * Alternative B — External search engine (Elasticsearch/Typesense):
 *   Operationally heavy. Adds network hops for every suggestion request.
 *   Unnecessary for a 500 K-row dataset that comfortably fits in RAM.
 *
 * Chosen — Trie with precomputed top-K:
 *   • Lookup: O(|prefix|) — traverse one node per character.
 *   • Top-K read: O(1) — each node stores its own top-10 list.
 *   • Insert cost: O(|query| × K) — update the K-list of each ancestor.
 *   • Space: O(alphabet × total_chars) nodes, each carrying K entries.
 *     For 500 K queries averaging 20 chars, with K=10, that is well under
 *     500 MB and fits comfortably in a typical server's RAM.
 *
 * Top-K maintenance on update:
 *   When a query's count increases (batch flush), walk from the leaf back up
 *   to root, and for each ancestor merge the new {query, count} entry into
 *   its sorted topK list (evicting the minimum if the list is already full
 *   and the new count is larger).  Cost: O(|query| × K log K).
 */

export interface TopKEntry {
  query: string;
  count: number;
}

class TrieNode {
  children: Map<string, TrieNode> = new Map();
  /** Top-K results for all queries in this subtree, sorted descending by count. */
  topK: TopKEntry[] = [];
  /** True if this node represents the end of a complete query string. */
  isEnd = false;
  /** The exact normalised query string ending here (set when isEnd=true). */
  query = '';
  /** Current count for this query (only meaningful when isEnd=true). */
  count = 0;
}

export class Trie {
  private readonly root: TrieNode = new TrieNode();
  private readonly K: number;

  constructor(k = 10) {
    this.K = k;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Insert or overwrite a query with a given count.
   * If the query already exists, its count is replaced (not incremented).
   * Use `update()` for incremental changes.
   */
  insert(query: string, count: number): void {
    let node = this.root;
    const path: TrieNode[] = [node];

    for (const ch of query) {
      let child = node.children.get(ch);
      if (!child) {
        child = new TrieNode();
        node.children.set(ch, child);
      }
      node = child;
      path.push(node);
    }

    node.isEnd = true;
    node.query = query;
    node.count = count;

    const entry: TopKEntry = { query, count };
    for (const ancestor of path) {
      this.mergeIntoTopK(ancestor, entry);
    }
  }

  /**
   * Increment the count of an existing query by `delta`.
   * If the query is not in the trie, this is a no-op (it will be inserted
   * by the next full rebuild or ingest).
   */
  update(query: string, delta: number): void {
    let node = this.root;
    const path: TrieNode[] = [node];

    for (const ch of query) {
      const child = node.children.get(ch);
      if (!child) {
        // Query not yet in trie — insert it fresh with the delta as count
        this.insert(query, delta);
        return;
      }
      node = child;
      path.push(node);
    }

    if (!node.isEnd) {
      // Leaf exists but was never finalised — treat as fresh insert
      this.insert(query, delta);
      return;
    }

    node.count += delta;
    const entry: TopKEntry = { query, count: node.count };

    for (const ancestor of path) {
      this.mergeIntoTopK(ancestor, entry);
    }
  }

  /**
   * Return the precomputed top-K entries for a given prefix.
   * O(|prefix|) traversal time; O(1) result read.
   */
  search(prefix: string): TopKEntry[] {
    let node = this.root;
    for (const ch of prefix) {
      const child = node.children.get(ch);
      if (!child) return [];
      node = child;
    }
    return node.topK.slice();
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Merge a single entry into a node's topK list.
   *
   * Cases:
   *   1. Entry already exists (same query) → update its count in-place.
   *   2. List not full (< K) → append.
   *   3. List full and new count > current minimum → replace the minimum.
   *   4. List full and new count ≤ minimum → no change.
   *
   * After any mutation the list is re-sorted and trimmed to K.
   */
  private mergeIntoTopK(node: TrieNode, entry: TopKEntry): void {
    const existingIdx = node.topK.findIndex((e) => e.query === entry.query);

    if (existingIdx !== -1) {
      // Update existing entry
      node.topK[existingIdx] = { ...entry };
    } else if (node.topK.length < this.K) {
      // Space available
      node.topK.push({ ...entry });
    } else {
      // Find the current minimum
      let minIdx = 0;
      for (let i = 1; i < node.topK.length; i++) {
        if (node.topK[i].count < node.topK[minIdx].count) minIdx = i;
      }
      if (entry.count > node.topK[minIdx].count) {
        node.topK[minIdx] = { ...entry };
      } else {
        return; // No change needed — skip sort
      }
    }

    // Re-sort descending and cap at K
    node.topK.sort((a, b) => b.count - a.count);
    if (node.topK.length > this.K) {
      node.topK.length = this.K;
    }
  }
}
