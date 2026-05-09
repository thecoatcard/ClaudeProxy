/**
 * lib/redis/client.ts
 *
 * Standard Redis client using ioredis, with an API surface that is
 * compatible with the @upstash/redis interface used throughout the codebase.
 *
 * Key translation layer:
 *   set(key, value, { ex: N })    → SET key value EX N
 *   zadd(key, { score, member })  → ZADD key score member
 *   zrange(key, 0, -1, {rev:true}) → ZREVRANGE key 0 -1
 *   pipeline().exec()             → unwraps [Error, value][] → value[]
 *   get<T>()                      → returns string | null (no auto JSON parse)
 *   hgetall()                     → normalises {} (missing key) to null
 *
 * Edge compatibility: ioredis requires Node.js TCP sockets.
 * Routes previously declared `runtime = 'edge'` that transitively import
 * this module must be changed to Node.js runtime (or have the runtime
 * directive removed).
 */
import { Redis as IoRedis } from 'ioredis';

// ─── Singleton connection ─────────────────────────────────────────────────────

let _client: IoRedis | null = null;

function getClient(): IoRedis {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      '[Redis] REDIS_URL is not set. ' +
      'Expected: redis://default:PASSWORD@HOST:PORT'
    );
  }

  _client = new IoRedis(url, {
    // Retry fast — gateway requests are latency-sensitive.
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    // Don't block the process if Redis is temporarily unreachable.
    lazyConnect: false,
    keepAlive: 30_000,
    connectTimeout: 5_000,
  });

  _client.on('error', (err: Error) => {
    // Log but never crash — all Redis calls are wrapped in try/catch by callers.
    console.error('[Redis] Connection error:', err.message);
  });

  return _client;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Serialize values for storage. Strings pass through; anything else is JSON-encoded. */
function serialize(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Normalise a hgetall result.
 * ioredis v5 returns null for non-existent keys; earlier versions may return {}.
 * We treat both null and empty-object the same way (key not found → null).
 */
function normalizeHash(
  val: Record<string, string> | null | undefined
): Record<string, string> | null {
  if (val == null) return null;
  if (typeof val === 'object' && Object.keys(val).length === 0) return null;
  return val;
}

/** Post-process a single pipeline result value for consumer-friendliness. */
function normalizeResultValue(val: unknown): unknown {
  // Normalise hgetall-style empty objects → null
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    return normalizeHash(val as Record<string, string>);
  }
  return val;
}

/**
 * Unwrap ioredis pipeline exec results from [[Error|null, T], …] to [T, …],
 * matching the shape that @upstash/redis pipeline.exec() returned.
 */
function unwrapPipeline(
  raw: [Error | null, unknown][] | null
): unknown[] {
  if (!raw) return [];
  return raw.map(([err, val]) => {
    if (err) return null;
    return normalizeResultValue(val);
  });
}

/** Parse a { score, member } Upstash-style zadd argument into ioredis arguments. */
function parseZaddArg(arg: { score: number; member: string }): [number, string] {
  if (
    arg == null ||
    typeof arg !== 'object' ||
    !('score' in arg) ||
    !('member' in arg)
  ) {
    throw new TypeError(
      `[Redis] zadd expects { score: number, member: string }, got: ${JSON.stringify(arg)}`
    );
  }
  return [Number(arg.score), String(arg.member)];
}

// ─── Pipeline wrapper ─────────────────────────────────────────────────────────

export class RedisPipeline {
  private _pipe: ReturnType<IoRedis['pipeline']>;

  constructor(pipe: ReturnType<IoRedis['pipeline']>) {
    this._pipe = pipe;
  }

  // Strings
  get(key: string) { this._pipe.get(key); return this; }
  set(key: string, value: unknown, opts?: { ex?: number }) {
    const str = serialize(value);
    opts?.ex ? this._pipe.set(key, str, 'EX', opts.ex) : this._pipe.set(key, str);
    return this;
  }
  setex(key: string, ttl: number, value: string) { this._pipe.setex(key, ttl, value); return this; }
  del(key: string) { this._pipe.del(key); return this; }
  incr(key: string) { this._pipe.incr(key); return this; }
  incrby(key: string, n: number) { this._pipe.incrby(key, n); return this; }
  expire(key: string, ttl: number) { this._pipe.expire(key, ttl); return this; }

  // Hashes
  hget(key: string, field: string) { this._pipe.hget(key, field); return this; }
  hgetall(key: string) { this._pipe.hgetall(key); return this; }
  hset(key: string, data: Record<string, unknown>) {
    this._pipe.hset(key, data as Record<string, string | number | Buffer>);
    return this;
  }
  hincrby(key: string, field: string, n: number) { this._pipe.hincrby(key, field, n); return this; }
  hdel(key: string, ...fields: string[]) { this._pipe.hdel(key, ...fields); return this; }

  // Sorted sets
  zadd(key: string, arg: { score: number; member: string }) {
    const [score, member] = parseZaddArg(arg);
    this._pipe.zadd(key, score, member);
    return this;
  }
  zrem(key: string, ...members: string[]) { this._pipe.zrem(key, ...members); return this; }

  // Sets
  sadd(key: string, ...members: string[]) { this._pipe.sadd(key, ...members); return this; }
  srem(key: string, ...members: string[]) { this._pipe.srem(key, ...members); return this; }

  // Lists
  lpush(key: string, ...values: unknown[]) {
    this._pipe.lpush(key, ...values.map(String));
    return this;
  }
  rpush(key: string, ...values: unknown[]) {
    this._pipe.rpush(key, ...values.map(String));
    return this;
  }
  ltrim(key: string, start: number, stop: number) { this._pipe.ltrim(key, start, stop); return this; }
  lrange(key: string, start: number, stop: number) { this._pipe.lrange(key, start, stop); return this; }
  exists(...keys: string[]) { this._pipe.exists(...keys); return this; }

  /** Execute the pipeline. Returns a plain array of results (Upstash-compatible). */
  async exec(): Promise<unknown[]> {
    const raw = await this._pipe.exec();
    return unwrapPipeline(raw as [Error | null, unknown][]);
  }
}

// ─── Main wrapper class ───────────────────────────────────────────────────────

export class RedisClient {
  // ── Strings ─────────────────────────────────────────────────────────────────

  /** get<T> is a type-annotation only — always returns string | null from standard Redis. */
  async get<T = string>(key: string): Promise<T | null> {
    return getClient().get(key) as unknown as T | null;
  }

  async mget<T = string[]>(keys: string[]): Promise<(string | null)[]> {
    if (!keys.length) return [];
    return getClient().mget(...keys);
  }

  async ping(): Promise<string> {
    return getClient().ping();
  }

  /**
   * set(key, value) or set(key, value, { ex: ttlSeconds })
   * Supports the Upstash { ex } options object.
   */
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    const str = serialize(value);
    if (opts?.ex) {
      await getClient().set(key, str, 'EX', opts.ex);
    } else {
      await getClient().set(key, str);
    }
  }

  async setex(key: string, ttl: number, value: string): Promise<void> {
    await getClient().setex(key, ttl, value);
  }

  async del(...keys: string[]): Promise<number> {
    return getClient().del(...keys);
  }

  async incr(key: string): Promise<number> {
    return getClient().incr(key);
  }

  async incrby(key: string, n: number): Promise<number> {
    return getClient().incrby(key, n);
  }

  async expire(key: string, ttl: number): Promise<number> {
    return getClient().expire(key, ttl);
  }

  async exists(...keys: string[]): Promise<number> {
    return getClient().exists(...keys);
  }

  // ── Hashes ───────────────────────────────────────────────────────────────────

  async hget(key: string, field: string): Promise<string | null> {
    return getClient().hget(key, field);
  }

  /** Returns null for non-existent keys (normalises ioredis {} → null). */
  async hgetall(key: string): Promise<Record<string, string> | null> {
    const val = await getClient().hgetall(key);
    return normalizeHash(val as Record<string, string> | null);
  }

  async hset(key: string, data: Record<string, unknown>): Promise<number> {
    return getClient().hset(
      key,
      data as Record<string, string | number | Buffer>
    );
  }

  async hincrby(key: string, field: string, n: number): Promise<number> {
    return getClient().hincrby(key, field, n);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    return getClient().hdel(key, ...fields);
  }

  // ── Sorted Sets ──────────────────────────────────────────────────────────────

  /**
   * zadd(key, { score, member })
   * Translates the Upstash object syntax to ioredis positional args.
   */
  async zadd(
    key: string,
    arg: { score: number; member: string }
  ): Promise<number> {
    const [score, member] = parseZaddArg(arg);
    return getClient().zadd(key, score, member) as Promise<number>;
  }

  /**
   * zrange(key, start, stop) or zrange(key, start, stop, { rev: true })
   * The { rev: true } option maps to ZREVRANGE.
   */
  async zrange<T = string[]>(
    key: string,
    start: number,
    stop: number,
    opts?: { rev?: boolean }
  ): Promise<T> {
    const client = getClient();
    if (opts?.rev) {
      return client.zrevrange(key, start, stop) as unknown as T;
    }
    return client.zrange(key, start, stop) as unknown as T;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    return getClient().zrem(key, ...members);
  }

  async zcard(key: string): Promise<number> {
    return getClient().zcard(key);
  }

  // ── Sets ─────────────────────────────────────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<number> {
    return getClient().sadd(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return getClient().smembers(key);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return getClient().srem(key, ...members);
  }

  // ── Lists ────────────────────────────────────────────────────────────────────

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return getClient().lrange(key, start, stop);
  }

  async lpush(key: string, ...values: unknown[]): Promise<number> {
    return getClient().lpush(key, ...values.map(String));
  }

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    return getClient().rpush(key, ...values.map(String));
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    return getClient().ltrim(key, start, stop);
  }

  async scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getClient() as any).scan(Number(cursor), ...args);
    return result as [string, string[]];
  }

  // ── Pipeline ─────────────────────────────────────────────────────────────────

  pipeline(): RedisPipeline {
    return new RedisPipeline(getClient().pipeline());
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  async quit(): Promise<void> {
    if (_client) {
      await _client.quit();
      _client = null;
    }
  }
}

export const redis = new RedisClient();
