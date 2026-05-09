/**
 * lib/memory/summary-memory.ts
 *
 * Manages task summaries and error summaries for embedding and retrieval.
 * Storage: Redis primary, .coatcard/summaries/ as dev-only cache.
 * Covers Part 7 (task memory) and Part 8 (error memory).
 */

import { embedSummary } from './embedding-engine';
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
   */
  async embedPending(vectorIndex: VectorIndex): Promise<number> {
    let count = 0;

    for (const summary of this.summaries.values()) {
      if (summary.embedded) continue;

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
        count++;
      } catch (err) {
        console.warn(`[SummaryStore] Failed to embed summary ${summary.id}:`, err);
      }
    }

    return count;
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
