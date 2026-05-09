import { redis } from '../redis';

export async function setexBestEffort(
  key: string,
  ttlSeconds: number,
  value: string,
  retries: number = 1
): Promise<boolean> {
  // BUG-013 FIX: Added exponential back-off between retries so a transient Redis
  // outage does not cause all retries to hammer the service simultaneously.
  // Delay: 100 ms × 2^attempt (100 ms, 200 ms, 400 ms, ...), capped at 2 s.
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await redis.setex(key, ttlSeconds, value);
      return true;
    } catch (err) {
      if (attempt >= retries) {
        console.warn('[metadata] setex failed', { key, retries, err: String(err) });
        return false;
      }
      const delayMs = Math.min(100 * Math.pow(2, attempt), 2000);
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
