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

export async function recordTokens(inputTokens: number, outputTokens: number) {
  const inTok = Math.max(0, Math.floor(Number(inputTokens) || 0));
  const outTok = Math.max(0, Math.floor(Number(outputTokens) || 0));
  if (inTok === 0 && outTok === 0) return;
  if (inTok > 0) await redis.incrby('stats:input_tokens', inTok);
  if (outTok > 0) await redis.incrby('stats:output_tokens', outTok);
}
