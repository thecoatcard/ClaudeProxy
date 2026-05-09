/**
 * lib/memory/redis-vector-store.ts
 *
 * Redis-backed primary vector storage.
 *
 * Storage hierarchy:
 *   Primary: Redis (always)
 *   Secondary: .coatcard local cache (dev-only, controlled by ENABLE_LOCAL_MEMORY_CACHE)
 *
 * Redis key layout (all scoped by workspace ID):
 *   vec:{wsId}:entry:{entryId}  → JSON-encoded VectorEntry
 *   vec:{wsId}:index            → Redis Set of all entry IDs
 *
 * Never stores data cross-project — workspaceId isolates tenants.
 */

import { redis } from '@/lib/redis';
import { cosineSimilarity } from './embedding-engine';
import { getWorkspaceId, isLocalCacheEnabled, getVectorsFilePath } from './project-memory-path';
import type { VectorEntry, SearchResult } from './vector-index';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TTL_SECONDS = 7 * 86_400; // 7 days

function entryKey(wsId: string, id: string): string {
  return `vec:${wsId}:entry:${id}`;
}

function indexKey(wsId: string): string {
  return `vec:${wsId}:index`;
}

// ---------------------------------------------------------------------------
// Redis Vector Store
// ---------------------------------------------------------------------------

export class RedisVectorStore {
  private wsId: string;

  constructor(workspaceId?: string) {
    this.wsId = workspaceId ?? getWorkspaceId();
  }

  /**
   * Insert or update a vector entry.
   * Uses a pipeline to batch set + sadd + expire into one round-trip.
   */
  async insert(entry: VectorEntry): Promise<void> {
    const r = redis as any;
    const key = entryKey(this.wsId, entry.id);
    const idxKey = indexKey(this.wsId);
    try {
      const pl = r.pipeline();
      pl.set(key, JSON.stringify(entry), 'EX', TTL_SECONDS);
      pl.sadd(idxKey, entry.id);
      pl.expire(idxKey, TTL_SECONDS);
      await pl.exec();
    } catch {
      // Fallback: individual commands if pipeline not available
      await r.set(key, JSON.stringify(entry), { ex: TTL_SECONDS }).catch(() => {});
      await r.sadd(idxKey, entry.id).catch(() => {});
      await r.expire(idxKey, TTL_SECONDS).catch(() => {});
    }
  }

  /**
   * Search for top-k most similar entries to a query vector.
   */
  async search(
    queryVector: number[],
    topK: number = 5,
    typeFilter?: VectorEntry['metadata']['type'],
  ): Promise<SearchResult[]> {
    const entries = await this.allEntries();
    const results: SearchResult[] = [];

    for (const entry of entries) {
      if (typeFilter && entry.metadata.type !== typeFilter) continue;
      const score = cosineSimilarity(queryVector, entry.vector);
      results.push({ entry, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Update an existing entry's vector and/or metadata.
   */
  async update(
    id: string,
    vector: number[],
    metadata: Partial<VectorEntry['metadata']>,
  ): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    const updated: VectorEntry = {
      ...existing,
      vector,
      metadata: { ...existing.metadata, ...metadata, embeddedAt: Date.now() },
    };
    await this.insert(updated);
    return true;
  }

  /**
   * Remove an entry by ID.
   */
  async remove(id: string): Promise<boolean> {
    const r = redis as any;
    const deleted = await r.del(entryKey(this.wsId, id)).catch(() => 0);
    await r.srem(indexKey(this.wsId), id).catch(() => {});
    return deleted > 0;
  }

  /**
   * Remove all entries whose ID starts with the given prefix.
   * Batches deletions into a pipeline for efficiency.
   */
  async removeByPrefix(prefix: string): Promise<number> {
    const ids = await this.allIds();
    const matching = ids.filter((id) => id.startsWith(prefix));
    if (matching.length === 0) return 0;

    const r = redis as any;
    const idxKey = indexKey(this.wsId);
    try {
      const pl = r.pipeline();
      for (const id of matching) {
        pl.del(entryKey(this.wsId, id));
        pl.srem(idxKey, id);
      }
      await pl.exec();
    } catch {
      // Fallback: sequential removal
      for (const id of matching) {
        await this.remove(id);
      }
    }
    return matching.length;
  }

  /**
   * Get a single entry by ID.
   */
  async get(id: string): Promise<VectorEntry | null> {
    const raw = await (redis as any).get(entryKey(this.wsId, id)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
    } catch {
      return null;
    }
  }

  /**
   * Check if an entry exists.
   */
  async has(id: string): Promise<boolean> {
    const raw = await (redis as any).get(entryKey(this.wsId, id)).catch(() => null);
    return raw !== null;
  }

  /**
   * Total number of entries.
   */
  async size(): Promise<number> {
    const ids = await this.allIds();
    return ids.length;
  }

  /**
   * Get all entry IDs from the index set.
   */
  async allIds(): Promise<string[]> {
    return (redis as any).smembers(indexKey(this.wsId)).catch(() => []);
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async allEntries(): Promise<VectorEntry[]> {
    const ids = await this.allIds();
    if (ids.length === 0) return [];

    const entries: VectorEntry[] = [];
    const r = redis as any;
    // Use mget for each batch — single round-trip per 50 entries
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const keys = batch.map((id) => entryKey(this.wsId, id));
      let raws: (string | null)[];
      try {
        raws = await r.mget(...keys);
      } catch {
        // Fallback: individual gets
        raws = await Promise.all(keys.map((k) => r.get(k).catch(() => null)));
      }
      for (const raw of raws) {
        if (!raw) continue;
        try {
          entries.push(JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)));
        } catch { /* skip corrupt */ }
      }
    }
    return entries;
  }

  // ─── Migration ──────────────────────────────────────────────────────────────

  /**
   * Import entries from a local vectors.json file into Redis.
   * Safe: skips entries that already exist.
   */
  async migrateFromDisk(): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;

    try {
      const fs = await import('fs');
      const vectorsPath = getVectorsFilePath();
      if (!fs.existsSync(vectorsPath)) return { imported: 0, skipped: 0 };

      const raw = fs.readFileSync(vectorsPath, 'utf-8');
      const entries: VectorEntry[] = JSON.parse(raw);

      for (const entry of entries) {
        const exists = await this.has(entry.id);
        if (exists) {
          skipped++;
        } else {
          await this.insert(entry);
          imported++;
        }
      }

      console.info(`[RedisVectorStore] Migration complete: ${imported} imported, ${skipped} skipped`);
    } catch (err) {
      console.warn('[RedisVectorStore] Migration from disk failed:', err);
    }

    return { imported, skipped };
  }

  /**
   * Export all entries to the local disk cache (dev-only).
   */
  async syncToDisk(): Promise<void> {
    if (!isLocalCacheEnabled()) return;

    try {
      const fs = await import('fs');
      const pathMod = await import('path');
      const vectorsPath = getVectorsFilePath();
      const dir = pathMod.dirname(vectorsPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const entries = await this.allEntries();
      fs.writeFileSync(vectorsPath, JSON.stringify(entries), 'utf-8');
    } catch (err) {
      console.warn('[RedisVectorStore] Sync to disk failed:', err);
    }
  }
}
