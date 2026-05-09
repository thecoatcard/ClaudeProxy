/**
 * lib/memory/vector-index.ts
 *
 * In-memory vector index with optional disk persistence.
 *
 * Storage hierarchy:
 *   Primary: Redis (via RedisVectorStore)
 *   Secondary: .coatcard/retrieval-index/vectors.json (dev-only cache)
 *
 * This class retains the in-memory Map for fast local reads during a
 * single request lifecycle.  Use RedisVectorStore directly for
 * cross-request persistence.
 */

import { cosineSimilarity } from './embedding-engine';
import {
  getVectorsFilePath,
  isLocalCacheEnabled,
  getWorkspaceRoot,
} from './project-memory-path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VectorEntry {
  /** Unique identifier (e.g. file path, task ID) */
  id: string;
  /** The embedding vector */
  vector: number[];
  /** Metadata for retrieval context */
  metadata: {
    /** Source type */
    type: 'file' | 'task' | 'error' | 'decision' | 'architecture';
    /** Human-readable title or path */
    title: string;
    /** Original text (truncated for storage) */
    text: string;
    /** Timestamp when embedded */
    embeddedAt: number;
    /** Optional chunk index for multi-chunk files */
    chunkIndex?: number;
  };
}

export interface SearchResult {
  /** The matching entry */
  entry: VectorEntry;
  /** Cosine similarity score (0-1) */
  score: number;
}

// ---------------------------------------------------------------------------
// Vector Index class
// ---------------------------------------------------------------------------

export class VectorIndex {
  private entries: Map<string, VectorEntry> = new Map();
  private indexPath: string;

  constructor(projectRoot?: string) {
    // Use canonical workspace path if not provided
    const root = projectRoot ?? getWorkspaceRoot();
    this.indexPath = getVectorsFilePath();
  }

  /**
   * Load the index from disk (optional local cache).
   * In production, callers should use RedisVectorStore instead.
   */
  load(): void {
    if (!isLocalCacheEnabled()) return;
    try {
      const fs = require('fs');
      if (fs.existsSync(this.indexPath)) {
        const raw = fs.readFileSync(this.indexPath, 'utf-8');
        const data: VectorEntry[] = JSON.parse(raw);
        this.entries = new Map(data.map((e: VectorEntry) => [e.id, e]));
      }
    } catch (err) {
      console.warn('[VectorIndex] Failed to load index:', err);
      this.entries = new Map();
    }
  }

  /**
   * Persist the index to disk (optional local cache).
   */
  save(): void {
    if (!isLocalCacheEnabled()) return;
    try {
      const fs = require('fs');
      const pathMod = require('path');
      const dir = pathMod.dirname(this.indexPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.entries.values());
      fs.writeFileSync(this.indexPath, JSON.stringify(data), 'utf-8');
    } catch (err) {
      console.warn('[VectorIndex] Failed to save index:', err);
    }
  }

  /**
   * Insert or update a vector entry.
   */
  insert(entry: VectorEntry): void {
    this.entries.set(entry.id, entry);
  }

  /**
   * Search for the top-k most similar entries to a query vector.
   *
   * @param queryVector - The query embedding vector
   * @param topK - Number of results to return (default 5)
   * @param typeFilter - Optional filter by entry type
   */
  search(
    queryVector: number[],
    topK: number = 5,
    typeFilter?: VectorEntry['metadata']['type']
  ): SearchResult[] {
    const results: SearchResult[] = [];

    for (const entry of this.entries.values()) {
      if (typeFilter && entry.metadata.type !== typeFilter) continue;

      const score = cosineSimilarity(queryVector, entry.vector);
      results.push({ entry, score });
    }

    // Sort by score descending, take top-k
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Update an existing entry (replaces vector and metadata).
   */
  update(id: string, vector: number[], metadata: Partial<VectorEntry['metadata']>): boolean {
    const existing = this.entries.get(id);
    if (!existing) return false;

    this.entries.set(id, {
      ...existing,
      vector,
      metadata: { ...existing.metadata, ...metadata, embeddedAt: Date.now() },
    });
    return true;
  }

  /**
   * Remove an entry by ID.
   */
  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * Remove all entries matching a prefix (e.g. all chunks of a file).
   */
  removeByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Get the number of entries in the index.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Check if an entry exists.
   */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Get an entry by ID.
   */
  get(id: string): VectorEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Get all entry IDs.
   */
  ids(): string[] {
    return Array.from(this.entries.keys());
  }
}
