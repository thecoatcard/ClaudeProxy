import { createHash } from 'node:crypto';
import type { RepositoryInsights } from './contracts';

type CachedRepository = {
  cacheKey: string;
  fingerprint: string;
  value: RepositoryInsights;
  storedAt: number;
};

function stableHash(value: string) {
  return createHash('sha1').update(value).digest('hex');
}

export class ProjectCache {
  private readonly repositoryCache = new Map<string, CachedRepository>();

  keyForWorkspace(root: string) {
    return stableHash(root.toLowerCase());
  }

  fingerprint(entries: Array<{ path: string; lastModifiedMs: number; size: number }>) {
    return stableHash(
      entries
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) => `${entry.path}:${entry.lastModifiedMs}:${entry.size}`)
        .join('|'),
    );
  }

  getRepository(cacheKey: string, fingerprint: string) {
    const cached = this.repositoryCache.get(cacheKey);
    if (!cached) return null;
    if (cached.fingerprint !== fingerprint) return null;
    return cached.value;
  }

  setRepository(cacheKey: string, fingerprint: string, value: RepositoryInsights) {
    this.repositoryCache.set(cacheKey, {
      cacheKey,
      fingerprint,
      value,
      storedAt: Date.now(),
    });
  }
}

export const globalProjectCache = new ProjectCache();
