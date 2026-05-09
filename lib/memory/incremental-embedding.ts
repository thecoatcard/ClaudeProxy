/**
 * lib/memory/incremental-embedding.ts
 *
 * Tracks file hashes to only re-embed changed files.
 * Stores hash state in .coatcard/artifacts/file-hashes.json (dev cache)
 * or Redis (production).
 *
 * Supports rename detection: if a file has the same content hash at a
 * different path, we update the path instead of re-embedding.
 */

import * as crypto from 'crypto';
import { getFileHashesPath, isLocalCacheEnabled } from './project-memory-path';
import type { FileEntry } from './file-ingestion';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileHashRecord {
  /** Relative file path */
  path: string;
  /** SHA-256 hash of file content */
  hash: string;
  /** Last embedded timestamp */
  embeddedAt: number;
  /** File size at embed time */
  size: number;
}

export interface IncrementalDiff {
  /** Files that are new or changed (need embedding) */
  changed: FileEntry[];
  /** Files that haven't changed (skip embedding) */
  unchanged: FileEntry[];
  /** Files in the hash store that no longer exist on disk */
  deleted: string[];
  /** Files that were renamed (same hash, different path) — no re-embedding needed */
  renamed: RenameDetection[];
}

export interface RenameDetection {
  /** Old path (from hash store) */
  oldPath: string;
  /** New path (from scanned files) */
  newPath: string;
  /** Content hash (identical) */
  hash: string;
}

// ---------------------------------------------------------------------------
// Hash store
// ---------------------------------------------------------------------------

export class FileHashStore {
  private hashes: Map<string, FileHashRecord> = new Map();
  private storePath: string;

  constructor(projectRoot?: string) {
    this.storePath = getFileHashesPath();
  }

  /**
   * Load hash records from disk (dev cache only).
   */
  load(): void {
    if (!isLocalCacheEnabled()) return;
    try {
      const fs = require('fs');
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        const records: FileHashRecord[] = JSON.parse(raw);
        this.hashes = new Map(records.map((r: FileHashRecord) => [r.path, r]));
      }
    } catch {
      this.hashes = new Map();
    }
  }

  /**
   * Save hash records to disk (dev cache only).
   */
  save(): void {
    if (!isLocalCacheEnabled()) return;
    try {
      const fs = require('fs');
      const pathMod = require('path');
      const dir = pathMod.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const records = Array.from(this.hashes.values());
      fs.writeFileSync(this.storePath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[FileHashStore] Failed to save:', err);
    }
  }

  /**
   * Compute the hash diff for a set of scanned files.
   * Returns which files need re-embedding, which are unchanged,
   * and which were renamed (same hash, different path).
   */
  computeDiff(files: FileEntry[]): IncrementalDiff {
    const changed: FileEntry[] = [];
    const unchanged: FileEntry[] = [];
    const renamed: RenameDetection[] = [];
    const currentPaths = new Set<string>();

    // Build a reverse map: hash → stored path (for rename detection)
    const hashToPath = new Map<string, string>();
    for (const [storedPath, record] of this.hashes) {
      hashToPath.set(record.hash, storedPath);
    }

    for (const file of files) {
      currentPaths.add(file.relativePath);
      const hash = hashContent(file.content);
      const existing = this.hashes.get(file.relativePath);

      if (existing && existing.hash === hash) {
        // Same path, same hash — unchanged
        unchanged.push(file);
      } else if (!existing && hashToPath.has(hash)) {
        // New path, but same hash exists at a different path — rename detected
        const oldPath = hashToPath.get(hash)!;
        if (!currentPaths.has(oldPath)) {
          renamed.push({ oldPath, newPath: file.relativePath, hash });
          unchanged.push(file); // Don't re-embed
        } else {
          changed.push(file); // Both old and new path exist — it's a copy, not rename
        }
      } else {
        changed.push(file);
      }
    }

    // Find deleted files (in hash store but not on disk, and not renamed)
    const renamedOldPaths = new Set(renamed.map((r) => r.oldPath));
    const deleted: string[] = [];
    for (const storedPath of this.hashes.keys()) {
      if (!currentPaths.has(storedPath) && !renamedOldPaths.has(storedPath)) {
        deleted.push(storedPath);
      }
    }

    return { changed, unchanged, deleted, renamed };
  }

  /**
   * Update the hash record for a file after embedding.
   */
  recordEmbedding(file: FileEntry): void {
    this.hashes.set(file.relativePath, {
      path: file.relativePath,
      hash: hashContent(file.content),
      embeddedAt: Date.now(),
      size: file.size,
    });
  }

  /**
   * Apply a rename: update the hash record's path without re-embedding.
   */
  applyRename(oldPath: string, newPath: string): void {
    const record = this.hashes.get(oldPath);
    if (!record) return;
    this.hashes.delete(oldPath);
    this.hashes.set(newPath, { ...record, path: newPath });
  }

  /**
   * Remove a hash record (for deleted files).
   */
  removeRecord(relativePath: string): void {
    this.hashes.delete(relativePath);
  }

  /**
   * Get the number of tracked files.
   */
  get size(): number {
    return this.hashes.size;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a string.
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
