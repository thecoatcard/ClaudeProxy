/**
 * lib/admin-cache.ts
 *
 * Lightweight in-memory response cache for admin/dashboard API routes.
 * Prevents aggressive dashboard polling from hammering Redis on every request.
 *
 * Cache entries expire after a configurable TTL (default 10s).
 * Cache is process-local — each worker/instance has its own cache.
 */

interface CacheEntry {
  data: any;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = Number(process.env.ADMIN_CACHE_TTL_MS || 10_000); // 10s

/**
 * Get a cached response or compute it.
 * If cached and not expired, returns cached data immediately.
 * Otherwise calls `compute()`, caches the result, and returns it.
 */
export async function cachedAdminResponse<T>(
  key: string,
  compute: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key);

  if (entry && entry.expiresAt > now) {
    return entry.data as T;
  }

  const data = await compute();
  cache.set(key, { data, expiresAt: now + ttlMs });

  // Lazy cleanup: remove expired entries every 50th call
  if (cache.size > 20 && Math.random() < 0.02) {
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k);
    }
  }

  return data;
}

/**
 * Invalidate a specific cache key (e.g., after a mutation).
 */
export function invalidateAdminCache(key: string): void {
  cache.delete(key);
}

/**
 * Invalidate all admin cache entries.
 */
export function invalidateAllAdminCache(): void {
  cache.clear();
}
