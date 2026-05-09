/**
 * lib/memory/summary-memory.ts
 *
 * Manages task summaries and error summaries for embedding and retrieval.
 * Storage: Redis primary, .coatcard/summaries/ as dev-only cache.
 * Covers Part 7 (task memory) and Part 8 (error memory).
 */

import { embedSummary, embedBatch } from './embedding-engine';
import { VectorIndex, type VectorEntry } from './vector-index';
import { getSummariesFilePath, isLocalCacheEnabled } from './project-memory-path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummaryRecord {
  /** Unique ID */
  id: string;
  /** Summary type */
  type: 'task' | 'error' | 'decision' | 'architecture';
  /** Short title */
  title: string;
  /** Full summary text */
  content: string;
  /** When this was recorded */
  createdAt: number;
  /** Whether this has been embedded into the vector index */
  embedded: boolean;
}

// ---------------------------------------------------------------------------
// Summary Store
// ---------------------------------------------------------------------------

export class SummaryStore {
  private summariesPath: string;
  private summaries: Map<string, SummaryRecord> = new Map();

  constructor(projectRoot?: string) {
    this.summariesPath = getSummariesFilePath();
  }

  /**
   * Load summaries from disk (dev cache only).
   */
  load(): void {
    if (!isLocalCacheEnabled()) return;
    try {
      const fs = require('fs');
      if (fs.existsSync(this.summariesPath)) {
        const raw = fs.readFileSync(this.summariesPath, 'utf-8');
        const records: SummaryRecord[] = JSON.parse(raw);
        this.summaries = new Map(records.map((r: SummaryRecord) => [r.id, r]));
      }
    } catch {
      this.summaries = new Map();
    }
  }

  /**
   * Save summaries to disk (dev cache only).
   */
  save(): void {
    if (!isLocalCacheEnabled()) return;
    try {
      const fs = require('fs');
      const pathMod = require('path');
      const dir = pathMod.dirname(this.summariesPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const records = Array.from(this.summaries.values());
      fs.writeFileSync(this.summariesPath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[SummaryStore] Failed to save:', err);
    }
  }

  /**
   * Add a task summary (Part 7).
   * Examples: "completed auth flow", "database schema decisions", "API architecture"
   */
  addTaskSummary(title: string, content: string): SummaryRecord {
    return this.addSummary('task', title, content);
  }

  /**
   * Add an error summary (Part 8).
   * Examples: "Prisma migration fix", "Next.js config fix", "dependency issue resolution"
   */
  addErrorSummary(title: string, content: string): SummaryRecord {
    return this.addSummary('error', title, content);
  }

  /**
   * Add a decision summary.
   */
  addDecisionSummary(title: string, content: string): SummaryRecord {
    return this.addSummary('decision', title, content);
  }

  /**
   * Add an architecture summary.
   */
  addArchitectureSummary(title: string, content: string): SummaryRecord {
    return this.addSummary('architecture', title, content);
  }

  /**
   * Embed all un-embedded summaries into the vector index.
   * Uses batch embedding for efficiency (one API call per chunk of 100).
   */
  async embedPending(vectorIndex: VectorIndex): Promise<number> {
    const pending = Array.from(this.summaries.values()).filter((s) => !s.embedded);
    if (pending.length === 0) return 0;

    // Build prefixed texts for batch embedding
    const texts = pending.map(
      (s) => `[${s.type.toUpperCase()}] ${s.title}\n---\n${s.content}`
    );

    let embedded = 0;
    try {
      const batch = await embedBatch(texts);
      for (let i = 0; i < pending.length; i++) {
        const summary = pending[i];
        const result = batch.embeddings[i];
        if (!result || result.vector.length === 0) continue;

        const entry: VectorEntry = {
          id: `summary:${summary.id}`,
          vector: result.vector,
          metadata: {
            type: summary.type,
            title: summary.title,
            text: summary.content.slice(0, 500),
            embeddedAt: Date.now(),
          },
        };
        vectorIndex.insert(entry);
        summary.embedded = true;
        embedded++;
      }
    } catch (err) {
      // Fallback: embed one by one so partial failures don't lose all summaries
      console.warn('[SummaryStore] Batch embed failed, falling back to sequential:', err);
      for (const summary of pending) {
        try {
          const result = await embedSummary(summary.type, summary.title, summary.content);
          const entry: VectorEntry = {
            id: `summary:${summary.id}`,
            vector: result.vector,
            metadata: {
              type: summary.type,
              title: summary.title,
              text: summary.content.slice(0, 500),
              embeddedAt: Date.now(),
            },
          };
          vectorIndex.insert(entry);
          summary.embedded = true;
          embedded++;
        } catch (innerErr) {
          console.warn(`[SummaryStore] Failed to embed summary ${summary.id}:`, innerErr);
        }
      }
    }

    return embedded;
  }

  /**
   * Get all summaries of a given type.
   */
  getByType(type: SummaryRecord['type']): SummaryRecord[] {
    return Array.from(this.summaries.values()).filter((s) => s.type === type);
  }

  /**
   * Get a summary by ID.
   */
  get(id: string): SummaryRecord | undefined {
    return this.summaries.get(id);
  }

  /**
   * Get total count.
   */
  get size(): number {
    return this.summaries.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private addSummary(
    type: SummaryRecord['type'],
    title: string,
    content: string
  ): SummaryRecord {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record: SummaryRecord = {
      id,
      type,
      title,
      content,
      createdAt: Date.now(),
      embedded: false,
    };
    this.summaries.set(id, record);
    return record;
  }
}
