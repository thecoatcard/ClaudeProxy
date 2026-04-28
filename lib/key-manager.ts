import { redis } from './redis';

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

export async function getHealthiestKeyObj(): Promise<{ id: string, key: string } | null> {
  const keys = await redis.zrange<string[]>('gemini:key_pool', 0, -1, { rev: true });
  const now = Math.floor(Date.now() / 1000);

  for (const keyId of keys) {
    const keyData = await redis.hgetall(`gemini:key:${keyId}`) as unknown as GeminiKey | null;
    if (!keyData || !keyData.key) continue;
    if (keyData.status === 'revoked') continue;

    const cooldownUntil = Number(keyData.cooldown_until || 0);
    const rpmUsed = Number(keyData.rpm_used || 0);
    const cooldownOver = cooldownUntil <= now;

    if (keyData.status === 'healthy' && cooldownOver) {
      return { id: keyId, key: keyData.key };
    }

    // Lazy recovery: cooldown period elapsed — mark healthy, clear the timer,
    // and restore the zset score so the key re-enters the healthy pool.
    if (keyData.status === 'cooldown' && cooldownOver) {
      await redis.hset(`gemini:key:${keyId}`, {
        status: 'healthy',
        failure_count: 0,
        cooldown_until: 0,
      });
      await redis.zadd('gemini:key_pool', { score: 100 - rpmUsed, member: keyId });
      return { id: keyId, key: keyData.key };
    }
  }
  return null;
}

export async function reportKeyFailure(id: string, isRateLimit: boolean) {
  const cooldownSecs = isRateLimit ? Number(process.env.KEY_COOLDOWN_429 || 60) : Number(process.env.KEY_COOLDOWN_503 || 20);
  const until = Math.floor(Date.now() / 1000) + cooldownSecs;
  
  await redis.hset(`gemini:key:${id}`, {
    status: 'cooldown',
    cooldown_until: until
  });
  await redis.hincrby(`gemini:key:${id}`, 'failure_count', 1);
  
  const data = await redis.hgetall(`gemini:key:${id}`) as unknown as GeminiKey;
  const failCount = Number(data.failure_count || 1);
  const rpmUsed = Number(data.rpm_used || 0);
  const score = 100 - rpmUsed - (failCount * 10);
  
  await redis.zadd('gemini:key_pool', { score, member: id });
}

export async function recordKeyUsage(id: string) {
  await redis.hset(`gemini:key:${id}`, { last_used: Math.floor(Date.now() / 1000) });
}
