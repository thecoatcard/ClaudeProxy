import { redis } from './redis';

export async function incrementRequestCount() {
  await redis.incr('stats:requests');
}

export async function incrementErrorCount() {
  await redis.incr('stats:errors');
}

export async function recordLatency(ms: number) {
  await redis.lpush('stats:latency', ms);
  await redis.ltrim('stats:latency', 0, 999);
}
