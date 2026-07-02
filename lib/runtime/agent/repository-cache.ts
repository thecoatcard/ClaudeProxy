import { createHash } from 'node:crypto';
import type { RepositoryInsights } from './contracts';

interface CacheEntry {
  fingerprint: string;
  analysis: RepositoryInsights;
}

export class RepositoryCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(root: string, fingerprint: string): RepositoryInsights | null {
    const entry = this.entries.get(root);
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint) return null;
    return entry.analysis;
  }

  set(root: string, fingerprint: string, analysis: RepositoryInsights) {
    this.entries.set(root, { fingerprint, analysis });
  }

  fingerprint(parts: Array<string | number | undefined | null>) {
    const hash = createHash('sha1');
    for (const part of parts) {
      hash.update(String(part ?? ''));
      hash.update('\n');
    }
    return hash.digest('hex');
  }
}
