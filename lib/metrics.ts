import { redis } from './redis';

export interface MetricMeta {
  model?: string;
  userToken?: string;
}

function utcDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function normalizeModel(model?: string): string {
  return (model || 'unknown').trim().toLowerCase();
}

export async function incrementRequestCount(meta: MetricMeta = {}) {
  const day = utcDay();
  const model = normalizeModel(meta.model);

  const pipeline = redis.pipeline();
  pipeline.incr('stats:requests');
  pipeline.incr(`stats:daily:${day}:requests`);
  pipeline.hincrby('stats:models:requests', model, 1);
  pipeline.hincrby(`stats:daily:${day}:models:requests`, model, 1);
  pipeline.sadd('stats:days', day);

  if (meta.userToken) {
    pipeline.hincrby(`stats:daily:${day}:users:requests`, meta.userToken, 1);
  }

  await pipeline.exec();
}

export async function incrementErrorCount(meta: MetricMeta = {}) {
  const day = utcDay();
  const model = normalizeModel(meta.model);

  const pipeline = redis.pipeline();
  pipeline.incr('stats:errors');
  pipeline.incr(`stats:daily:${day}:errors`);
  pipeline.hincrby('stats:models:errors', model, 1);
  pipeline.hincrby(`stats:daily:${day}:models:errors`, model, 1);
  pipeline.sadd('stats:days', day);

  if (meta.userToken) {
    pipeline.hincrby(`stats:daily:${day}:users:errors`, meta.userToken, 1);
  }

  await pipeline.exec();
}

export async function recordLatency(ms: number) {
  const day = utcDay();
  const rounded = Math.max(0, Math.round(Number(ms) || 0));
  const pipeline = redis.pipeline();

  pipeline.lpush('stats:latency', rounded);
  pipeline.ltrim('stats:latency', 0, 999);
  pipeline.lpush(`stats:daily:${day}:latency`, rounded);
  pipeline.ltrim(`stats:daily:${day}:latency`, 0, 999);
  pipeline.sadd('stats:days', day);

  await pipeline.exec();
}

export async function recordTokens(inputTokens: number, outputTokens: number, meta: MetricMeta = {}) {
  const inTok = Math.max(0, Math.floor(Number(inputTokens) || 0));
  const outTok = Math.max(0, Math.floor(Number(outputTokens) || 0));
  const total = inTok + outTok;
  if (total === 0) return;

  const day = utcDay();
  const model = normalizeModel(meta.model);
  const pipeline = redis.pipeline();

  if (inTok > 0) {
    pipeline.incrby('stats:input_tokens', inTok);
    pipeline.incrby(`stats:daily:${day}:input_tokens`, inTok);
    pipeline.hincrby('stats:models:input_tokens', model, inTok);
    pipeline.hincrby(`stats:daily:${day}:models:input_tokens`, model, inTok);
  }

  if (outTok > 0) {
    pipeline.incrby('stats:output_tokens', outTok);
    pipeline.incrby(`stats:daily:${day}:output_tokens`, outTok);
    pipeline.hincrby('stats:models:output_tokens', model, outTok);
    pipeline.hincrby(`stats:daily:${day}:models:output_tokens`, model, outTok);
  }

  pipeline.incrby(`stats:daily:${day}:total_tokens`, total);
  pipeline.hincrby('stats:models:total_tokens', model, total);
  pipeline.hincrby(`stats:daily:${day}:models:total_tokens`, model, total);
  pipeline.sadd('stats:days', day);

  if (meta.userToken) {
    pipeline.hincrby(`user:key:${meta.userToken}`, 'input_tokens', inTok);
    pipeline.hincrby(`user:key:${meta.userToken}`, 'output_tokens', outTok);
    pipeline.hincrby(`user:key:${meta.userToken}`, 'total_tokens', total);
    pipeline.hincrby(`stats:daily:${day}:users:total_tokens`, meta.userToken, total);
  }

  await pipeline.exec();
}
