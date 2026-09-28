/**
 * In-memory map from model id -> CLI session id. Bounded LRU.
 * Session ids are secrets-adjacent (they index transcripts on disk); this map
 * is never persisted to disk and never leaves the extension host process.
 *
 * §4.9. Capacity 32 bounds memory and matches "one live session per recently
 * used model". A cache miss is never an error — it just means a cold turn, and
 * a dropped `-r` degrades cost only, never correctness (D1).
 *
 * This module imports nothing. Not `vscode`, not `node:fs`, nothing: it is a
 * leaf with no intra-project dependency, so it stays loadable from a plain
 * vitest run with no alias and no stub (§3.1).
 */
export class TranscriptStore {
  /**
   * Insertion order IS recency: the least recently used key is the first one
   * `keys()` yields. A `Map` therefore gives an O(1) LRU on its own, and
   * `set` refreshing recency is the delete-then-reinsert below.
   */
  private readonly entries = new Map<string, string>();

  constructor(private readonly capacity = 32) {}

  get(modelId: string): string | null {
    return this.entries.get(modelId) ?? null;
  }

  set(modelId: string, sessionId: string): void {
    // Delete before re-inserting: a bare `set` on an existing key would keep
    // the original position and the key would be evicted while very much
    // still in use. Re-inserting moves it to the back, i.e. most recent.
    this.entries.delete(modelId);
    this.entries.set(modelId, sessionId);

    // Evict from the front until the store fits. Guarded on the iterator so a
    // non-positive capacity degrades to "holds nothing" rather than looping.
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
