import { redis } from './redis';

const CACHE_ENABLED = process.env.GEMINI_CACHE_ENABLED === 'true';

export interface GeminiKey {
  key: string;
  status: 'healthy' | 'cooldown' | 'revoked';
  rpm_used: number;
  tpm_used: number;
  daily_used: number;
  failure_count: number;
  cooldown_until: number;
  last_used: number;
}

export async function getHealthiestKeyObj(userId?: string): Promise<{ id: string, key: string } | null> {
  // Get all key IDs sorted by health/score
  const keys = await redis.zrange<string[]>('gemini:key_pool', 0, -1, { rev: true });
  if (keys.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);

  // --- Auto-Restoration Logic ---
  // Periodically check for keys that have completed their cooldown and restore them.
  const restoreKeys = async () => {
    // Check frequently (30% of requests)
    if (Math.random() > 0.3) return;

    const cooldownKeys = await redis.zrange('gemini:key_pool', 0, 49); // Low scores
    if (cooldownKeys.length === 0) return;

    const pipeline = redis.pipeline();
    const now = Math.floor(Date.now() / 1000);
    
    for (const id of cooldownKeys) {
      pipeline.hgetall(`gemini:key:${id}`);
    }
    
    const dataList = await pipeline.exec() as (GeminiKey | null)[];
    const restorePipeline = redis.pipeline();
    let restoredCount = 0;

    for (let i = 0; i < cooldownKeys.length; i++) {
      const id = cooldownKeys[i];
      const data = dataList[i];
      if (!data || data.status === 'revoked') continue;

      const cooldownUntil = Number(data.cooldown_until || 0);
      if (data.status === 'cooldown' && (cooldownUntil === 0 || cooldownUntil <= now)) {
        restorePipeline.hset(`gemini:key:${id}`, { status: 'healthy', failure_count: 0, cooldown_until: 0, rpm_used: 0 });
        restorePipeline.zadd('gemini:key_pool', { score: 100, member: id });
        restoredCount++;
      }
    }
    
    if (restoredCount > 0) {
      await restorePipeline.exec();
      console.log(`[Auto-Restore] Restored ${restoredCount} keys from cooldown.`);
    }
  };
  restoreKeys().catch(() => {});
  // ------------------------------------------------

  // If caching is enabled, try the sticky key first.
  let preferredId: string | null = null;
  if (CACHE_ENABLED && userId) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = ((hash << 5) - hash) + userId.charCodeAt(i);
      hash |= 0; 
    }
    preferredId = keys[Math.abs(hash) % keys.length];
  }

  // To handle 93+ keys efficiently, we pipeline the metadata lookup for the 
  // top 10 healthiest candidates in one round-trip.
  const candidates = preferredId 
    ? [preferredId, ...keys.filter(id => id !== preferredId).slice(0, 9)]
    : keys.slice(0, 10);

  const pipeline = redis.pipeline();
  for (const id of candidates) {
    pipeline.hgetall(`gemini:key:${id}`);
  }
  
  const results = await pipeline.exec() as (GeminiKey | null)[];

  for (let i = 0; i < candidates.length; i++) {
    const keyId = candidates[i];
    const keyData = results[i];

    if (!keyData || !keyData.key || keyData.status === 'revoked') continue;

    const cooldownUntil = Number(keyData.cooldown_until || 0);
    const rpmUsed = Number(keyData.rpm_used || 0);
    const cooldownOver = cooldownUntil <= now;

    if (keyData.status === 'healthy' && cooldownOver) {
      return { id: keyId, key: keyData.key };
    }

    if (keyData.status === 'cooldown' && cooldownOver) {
      // Lazy recovery
      await Promise.all([
        redis.hset(`gemini:key:${keyId}`, { status: 'healthy', failure_count: 0, cooldown_until: 0, rpm_used: 0 }),
        redis.zadd('gemini:key_pool', { score: 100, member: keyId })
      ]);
      return { id: keyId, key: keyData.key };
    }
  }

  // Fallback: If top 10 are all busy, do a batched scan of the rest (pipeline batches of 20)
  if (keys.length > 10) {
    const BATCH_SIZE = 20;
    for (let i = 10; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      const pipeline = redis.pipeline();
      for (const id of batch) {
        pipeline.hgetall(`gemini:key:${id}`);
      }
      const results = await pipeline.exec() as (GeminiKey | null)[];

      for (let j = 0; j < batch.length; j++) {
        const keyId = batch[j];
        const keyData = results[j];
        if (!keyData || !keyData.key || keyData.status === 'revoked') continue;

        const cooldownUntil = Number(keyData.cooldown_until || 0);
        const cooldownOver = cooldownUntil <= now;

        if (keyData.status === 'healthy' && cooldownOver) {
          return { id: keyId, key: keyData.key };
        }

        if (keyData.status === 'cooldown' && cooldownOver) {
          // Lazy recovery
          await Promise.all([
            redis.hset(`gemini:key:${keyId}`, { status: 'healthy', failure_count: 0, cooldown_until: 0, rpm_used: 0 }),
            redis.zadd('gemini:key_pool', { score: 100, member: keyId })
          ]);
          return { id: keyId, key: keyData.key };
        }
      }
    }
  }

  return null;
}

export async function reportKeyFailure(id: string, type: 'ratelimit' | 'server' | 'auth') {
  if (type === 'auth') {
    // Permanently disable revoked/invalid keys
    await Promise.all([
      redis.hset(`gemini:key:${id}`, { status: 'revoked', failure_count: 999 }),
      redis.zrem('gemini:key_pool', id)
    ]);
    console.warn(`[KeyManager] Key ${id} revoked (403 Forbidden). Removed from pool.`);
    return;
  }

  const cooldownSecs = type === 'ratelimit' 
    ? Number(process.env.KEY_COOLDOWN_429 || 60) 
    : Number(process.env.KEY_COOLDOWN_503 || 20);
    
  const until = Math.floor(Date.now() / 1000) + cooldownSecs;
  
  await redis.hset(`gemini:key:${id}`, {
    status: 'cooldown',
    cooldown_until: until
  });
  await redis.hincrby(`gemini:key:${id}`, 'failure_count', 1);
  
  const data = await redis.hgetall(`gemini:key:${id}`) as unknown as GeminiKey | null;
  const failCount = Number(data?.failure_count || 1);
  const rpmUsed = Number(data?.rpm_used || 0);
  const score = 100 - rpmUsed - (failCount * 10);
  
  await redis.zadd('gemini:key_pool', { score, member: id });
}

export async function recordKeyUsage(id: string) {
  const now = Math.floor(Date.now() / 1000);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const keyMeta = await redis.hgetall(`gemini:key:${id}`) as unknown as GeminiKey & { daily_used_date?: string } | null;

  const usagePipeline = redis.pipeline();
  usagePipeline.hset(`gemini:key:${id}`, { last_used: now });
  usagePipeline.hincrby(`gemini:key:${id}`, 'rpm_used', 1);
  usagePipeline.hincrby(`gemini:key:${id}`, 'total_used', 1);
  usagePipeline.incrby(`gemini:key:${id}:daily:${today}:requests`, 1);

  if (!keyMeta || (keyMeta as any).daily_used_date !== today) {
    usagePipeline.hset(`gemini:key:${id}`, { daily_used: 1, daily_used_date: today });
  } else {
    usagePipeline.hincrby(`gemini:key:${id}`, 'daily_used', 1);
  }

  await usagePipeline.exec();
}

export async function resetAllKeys() {
  const keys = await redis.zrange<string[]>('gemini:key_pool', 0, -1);
  if (!keys || keys.length === 0) return;

  const pipeline = redis.pipeline();
  for (const id of keys) {
    pipeline.hset(`gemini:key:${id}`, {
      status: 'healthy',
      failure_count: 0,
      cooldown_until: 0,
      rpm_used: 0,
    });
    // Reset scores to a high starting value (e.g. 100)
    pipeline.zadd('gemini:key_pool', { score: 100, member: id });
  }
  await pipeline.exec();
}
