/**
 * lib/redis/client.ts
 *
 * Resilient Redis wrapper used across the app. It preflights host resolution
 * and connection attempts once, then degrades to a disabled client if Redis is
 * unreachable. That prevents noisy ENOTFOUND loops and keeps the rest of the
 * app fail-closed instead of crashing.
 */
import { lookup } from 'node:dns/promises';
import { Redis as IoRedis } from 'ioredis';

type RedisLike = {
  get(key: string): Promise<any>;
  mget(...keys: string[]): Promise<any>;
  ping(): Promise<any>;
  set(...args: any[]): Promise<any>;
  setex(...args: any[]): Promise<any>;
  del(...args: any[]): Promise<any>;
  incr(key: string): Promise<any>;
  incrby(key: string, n: number): Promise<any>;
  expire(key: string, ttl: number): Promise<any>;
  exists(...keys: string[]): Promise<any>;
  hget(key: string, field: string): Promise<any>;
  hgetall(key: string): Promise<any>;
  hset(...args: any[]): Promise<any>;
  hincrby(key: string, field: string, n: number): Promise<any>;
  hdel(...args: any[]): Promise<any>;
  zadd(...args: any[]): Promise<any>;
  zrange(...args: any[]): Promise<any>;
  zrevrange(...args: any[]): Promise<any>;
  zrem(...args: any[]): Promise<any>;
  zcard(key: string): Promise<any>;
  sadd(...args: any[]): Promise<any>;
  smembers(key: string): Promise<any>;
  srem(...args: any[]): Promise<any>;
  lrange(...args: any[]): Promise<any>;
  lpush(...args: any[]): Promise<any>;
  rpush(...args: any[]): Promise<any>;
  ltrim(...args: any[]): Promise<any>;
  scan(...args: any[]): Promise<any>;
  pipeline(): RedisPipelineLike;
  quit(): Promise<any>;
};

type RedisPipelineLike = ReturnType<IoRedis['pipeline']>;

class DisabledRedisPipeline {
  get(..._args: any[]) { return this; }
  set(..._args: any[]) { return this; }
  setex(..._args: any[]) { return this; }
  del(..._args: any[]) { return this; }
  incr(..._args: any[]) { return this; }
  incrby(..._args: any[]) { return this; }
  expire(..._args: any[]) { return this; }
  hget(..._args: any[]) { return this; }
  hgetall(..._args: any[]) { return this; }
  hset(..._args: any[]) { return this; }
  hincrby(..._args: any[]) { return this; }
  hdel(..._args: any[]) { return this; }
  zadd(..._args: any[]) { return this; }
  zrem(..._args: any[]) { return this; }
  sadd(..._args: any[]) { return this; }
  srem(..._args: any[]) { return this; }
  lpush(..._args: any[]) { return this; }
  rpush(..._args: any[]) { return this; }
  ltrim(..._args: any[]) { return this; }
  lrange(..._args: any[]) { return this; }
  exists(..._args: any[]) { return this; }
  async exec(): Promise<unknown[]> { return []; }
}

class DisabledRedisClient implements RedisLike {
  async get() { return null; }
  async mget() { return []; }
  async ping() { return 'PONG' as const; }
  async set() { return 'OK' as const; }
  async setex() { return 'OK' as const; }
  async del() { return 0; }
  async incr() { return 0; }
  async incrby() { return 0; }
  async expire() { return 0; }
  async exists() { return 0; }
  async hget() { return null; }
  async hgetall() { return null; }
  async hset() { return 0; }
  async hincrby() { return 0; }
  async hdel() { return 0; }
  async zadd() { return 0; }
  async zrange() { return []; }
  async zrevrange() { return []; }
  async zrem() { return 0; }
  async zcard() { return 0; }
  async sadd() { return 0; }
  async smembers() { return []; }
  async srem() { return 0; }
  async lrange() { return []; }
  async lpush() { return 0; }
  async rpush() { return 0; }
  async ltrim() { return 'OK' as const; }
  async scan() { return ['0', []] as [string, string[]]; }
  pipeline() { return new DisabledRedisPipeline() as unknown as RedisPipelineLike; }
  async quit() { return 'OK' as const; }
}

let clientPromise: Promise<RedisLike> | null = null;
let disabledReason: string | null = null;
const disabledClient = new DisabledRedisClient();

function serialize(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeHash(val: Record<string, string> | null | undefined): Record<string, string> | null {
  if (val == null) return null;
  if (Object.keys(val).length === 0) return null;
  return val;
}

function parseZaddArg(arg: { score: number; member: string }): [number, string] {
  if (!arg || typeof arg !== 'object' || !('score' in arg) || !('member' in arg)) {
    throw new TypeError(`[Redis] zadd expects { score: number, member: string }`);
  }
  return [Number(arg.score), String(arg.member)];
}

function normalizeResultValue(val: unknown): unknown {
  if (val !== null && typeof val === 'object' && !Array.isArray(val) && Object.keys(val as Record<string, unknown>).length === 0) {
    return null;
  }
  return val;
}

function unwrapPipeline(raw: [Error | null, unknown][] | null): unknown[] {
  if (!raw) return [];
  return raw.map(([err, val]) => (err ? null : normalizeResultValue(val)));
}

async function buildClient(): Promise<RedisLike> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    disabledReason = 'REDIS_URL is not set';
    return disabledClient;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    disabledReason = 'REDIS_URL is invalid';
    return disabledClient;
  }

  try {
    await lookup(parsed.hostname);
  } catch (error) {
    disabledReason = `Redis host cannot be resolved: ${parsed.hostname}`;
    console.warn(`[Redis] ${disabledReason}`);
    return disabledClient;
  }

  const client = new IoRedis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    keepAlive: 30_000,
    connectTimeout: 5_000,
    retryStrategy: () => null,
  });

  client.on('error', (err: Error) => {
    if (!disabledReason) {
      disabledReason = `Redis connection unavailable: ${err.message}`;
      console.warn(`[Redis] ${disabledReason}`);
    }
  });

  try {
    await client.connect();
    return client;
  } catch (error) {
    disabledReason = `Redis connection unavailable: ${(error as Error).message}`;
    console.warn(`[Redis] ${disabledReason}`);
    try {
      await client.disconnect();
    } catch {}
    return disabledClient;
  }
}

async function getClient(): Promise<RedisLike> {
  if (disabledReason) return disabledClient;
  if (!clientPromise) {
    clientPromise = buildClient().catch((error) => {
      disabledReason = (error as Error).message;
      return disabledClient;
    });
  }
  return clientPromise;
}

export class RedisPipeline {
  private readonly pipe?: RedisPipelineLike;
  private readonly ops: Array<(pipe: RedisPipelineLike) => void> = [];

  constructor(pipe?: RedisPipelineLike) {
    this.pipe = pipe;
  }

  get(key: string) { if (this.pipe) this.pipe.get(key); else this.ops.push((pipe) => { pipe.get(key); }); return this; }
  set(key: string, value: unknown, opts?: { ex?: number }) {
    if (this.pipe) {
      const str = serialize(value);
      opts?.ex ? this.pipe.set(key, str, 'EX', opts.ex) : this.pipe.set(key, str);
      return this;
    }
    this.ops.push((pipe) => {
      const str = serialize(value);
      opts?.ex ? pipe.set(key, str, 'EX', opts.ex) : pipe.set(key, str);
    });
    return this;
  }
  setex(key: string, ttl: number, value: string) { if (this.pipe) this.pipe.setex(key, ttl, value); else this.ops.push((pipe) => { pipe.setex(key, ttl, value); }); return this; }
  del(key: string) { if (this.pipe) this.pipe.del(key); else this.ops.push((pipe) => { pipe.del(key); }); return this; }
  incr(key: string) { if (this.pipe) this.pipe.incr(key); else this.ops.push((pipe) => { pipe.incr(key); }); return this; }
  incrby(key: string, n: number) { if (this.pipe) this.pipe.incrby(key, n); else this.ops.push((pipe) => { pipe.incrby(key, n); }); return this; }
  expire(key: string, ttl: number) { if (this.pipe) this.pipe.expire(key, ttl); else this.ops.push((pipe) => { pipe.expire(key, ttl); }); return this; }
  hget(key: string, field: string) { if (this.pipe) this.pipe.hget(key, field); else this.ops.push((pipe) => { pipe.hget(key, field); }); return this; }
  hgetall(key: string) { if (this.pipe) this.pipe.hgetall(key); else this.ops.push((pipe) => { pipe.hgetall(key); }); return this; }
  hset(key: string, data: Record<string, unknown>) { if (this.pipe) this.pipe.hset(key, data as Record<string, string | number | Buffer>); else this.ops.push((pipe) => { pipe.hset(key, data as Record<string, string | number | Buffer>); }); return this; }
  hincrby(key: string, field: string, n: number) { if (this.pipe) this.pipe.hincrby(key, field, n); else this.ops.push((pipe) => { pipe.hincrby(key, field, n); }); return this; }
  hdel(key: string, ...fields: string[]) { if (this.pipe) this.pipe.hdel(key, ...fields); else this.ops.push((pipe) => { pipe.hdel(key, ...fields); }); return this; }
  zadd(key: string, arg: { score: number; member: string }) {
    if (this.pipe) {
      const [score, member] = parseZaddArg(arg);
      this.pipe.zadd(key, score, member);
      return this;
    }
    this.ops.push((pipe) => { const [score, member] = parseZaddArg(arg); pipe.zadd(key, score, member); });
    return this;
  }
  zrem(key: string, ...members: string[]) { if (this.pipe) this.pipe.zrem(key, ...members); else this.ops.push((pipe) => { pipe.zrem(key, ...members); }); return this; }
  sadd(key: string, ...members: string[]) { if (this.pipe) this.pipe.sadd(key, ...members); else this.ops.push((pipe) => { pipe.sadd(key, ...members); }); return this; }
  srem(key: string, ...members: string[]) { if (this.pipe) this.pipe.srem(key, ...members); else this.ops.push((pipe) => { pipe.srem(key, ...members); }); return this; }
  lpush(key: string, ...values: unknown[]) { if (this.pipe) this.pipe.lpush(key, ...values.map(String)); else this.ops.push((pipe) => { pipe.lpush(key, ...values.map(String)); }); return this; }
  rpush(key: string, ...values: unknown[]) { if (this.pipe) this.pipe.rpush(key, ...values.map(String)); else this.ops.push((pipe) => { pipe.rpush(key, ...values.map(String)); }); return this; }
  ltrim(key: string, start: number, stop: number) { if (this.pipe) this.pipe.ltrim(key, start, stop); else this.ops.push((pipe) => { pipe.ltrim(key, start, stop); }); return this; }
  lrange(key: string, start: number, stop: number) { if (this.pipe) this.pipe.lrange(key, start, stop); else this.ops.push((pipe) => { pipe.lrange(key, start, stop); }); return this; }
  exists(...keys: string[]) { if (this.pipe) this.pipe.exists(...keys); else this.ops.push((pipe) => { pipe.exists(...keys); }); return this; }

  async exec(): Promise<unknown[]> {
    if (this.pipe) {
      const raw = await this.pipe.exec();
      return unwrapPipeline(raw as [Error | null, unknown][]);
    }
    const client = await getClient();
    const pipe = client.pipeline();
    for (const op of this.ops) {
      op(pipe);
    }
    const raw = await pipe.exec();
    return unwrapPipeline(raw as [Error | null, unknown][]);
  }
}

export class RedisClient {
  async get<T = string>(key: string): Promise<T | null> {
    const client = await getClient();
    return client.get(key) as unknown as T | null;
  }

  async mget<T = string[]>(keys: string[]): Promise<(string | null)[]> {
    if (!keys.length) return [];
    const client = await getClient();
    return client.mget(...keys);
  }

  async ping(): Promise<string> {
    const client = await getClient();
    return client.ping();
  }

  async set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<string | null> {
    const client = await getClient();
    const str = serialize(value);
    if (opts?.nx && opts?.ex) return client.set(key, str, 'EX', opts.ex, 'NX');
    if (opts?.nx) return client.set(key, str, 'NX');
    if (opts?.ex) return client.set(key, str, 'EX', opts.ex);
    return client.set(key, str);
  }

  async setex(key: string, ttl: number, value: string): Promise<void> {
    const client = await getClient();
    await client.setex(key, ttl, value);
  }

  async del(...keys: string[]): Promise<number> {
    const client = await getClient();
    return client.del(...keys);
  }

  async incr(key: string): Promise<number> {
    const client = await getClient();
    return client.incr(key);
  }

  async incrby(key: string, n: number): Promise<number> {
    const client = await getClient();
    return client.incrby(key, n);
  }

  async expire(key: string, ttl: number): Promise<number> {
    const client = await getClient();
    return client.expire(key, ttl);
  }

  async exists(...keys: string[]): Promise<number> {
    const client = await getClient();
    return client.exists(...keys);
  }

  async hget(key: string, field: string): Promise<string | null> {
    const client = await getClient();
    return client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const client = await getClient();
    const val = await client.hgetall(key);
    return normalizeHash(val as Record<string, string> | null);
  }

  async hset(key: string, data: Record<string, unknown>): Promise<number> {
    const client = await getClient();
    return client.hset(key, data as Record<string, string | number | Buffer>);
  }

  async hincrby(key: string, field: string, n: number): Promise<number> {
    const client = await getClient();
    return client.hincrby(key, field, n);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const client = await getClient();
    return client.hdel(key, ...fields);
  }

  async zadd(key: string, arg: { score: number; member: string }): Promise<number> {
    const client = await getClient();
    const [score, member] = parseZaddArg(arg);
    return client.zadd(key, score, member) as Promise<number>;
  }

  async zrange<T = string[]>(key: string, start: number, stop: number, opts?: { rev?: boolean }): Promise<T> {
    const client = await getClient();
    if (opts?.rev) return client.zrevrange(key, start, stop) as unknown as T;
    return client.zrange(key, start, stop) as unknown as T;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const client = await getClient();
    return client.zrem(key, ...members);
  }

  async zcard(key: string): Promise<number> {
    const client = await getClient();
    return client.zcard(key);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const client = await getClient();
    return client.sadd(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    const client = await getClient();
    return client.smembers(key);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const client = await getClient();
    return client.srem(key, ...members);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const client = await getClient();
    return client.lrange(key, start, stop);
  }

  async lpush(key: string, ...values: unknown[]): Promise<number> {
    const client = await getClient();
    return client.lpush(key, ...values.map(String));
  }

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    const client = await getClient();
    return client.rpush(key, ...values.map(String));
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    const client = await getClient();
    return client.ltrim(key, start, stop);
  }

  async scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]> {
    const client = await getClient();
    const result = await (client as unknown as { scan: (...args: unknown[]) => Promise<[string, string[]]> }).scan(Number(cursor), ...args);
    return result;
  }

  pipeline(): RedisPipeline {
    return new RedisPipeline();
  }

  async quit(): Promise<void> {
    if (clientPromise) {
      const client = await clientPromise.catch(() => null);
      await client?.quit();
    }
    clientPromise = null;
    disabledReason = null;
  }
}

export const redis = new RedisClient();

export function isRedisUnavailable() {
  return Boolean(disabledReason);
}
