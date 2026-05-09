import { redis } from '../redis';

export async function setexBestEffort(
  key: string,
  ttlSeconds: number,
  value: string,
  retries: number = 1
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await redis.setex(key, ttlSeconds, value);
      return true;
    } catch (err) {
      if (attempt >= retries) {
        console.warn('[metadata] setex failed', { key, retries, err: String(err) });
        return false;
      }
    }
  }
  return false;
}
