import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://default:gFeIfmmXyK7sOitIQjmwQ9EaG4EmP5Q6@redis-13679.c252.ap-southeast-1-1.ec2.cloud.redislabs.com:13679';

const client = new Redis(redisUrl);

// Helper to auto-parse JSON and Numbers from Redis strings
function parseRedisValue(val: string | null): any {
  if (val === null) return null;
  if (val === 'undefined') return undefined;
  if (val === 'null') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  
  // Auto-convert numbers
  if (/^-?\d+(\.\d+)?$/.test(val)) {
    return Number(val);
  }

  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

export const redis = {
  async get<T>(key: string): Promise<T | null> {
    const val = await client.get(key);
    return parseRedisValue(val) as T;
  },

  async set(key: string, value: any, options?: { ex?: number }): Promise<void> {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    if (options?.ex) {
      await client.set(key, stringValue, 'EX', options.ex);
    } else {
      await client.set(key, stringValue);
    }
  },

  async setex(key: string, seconds: number, value: any): Promise<void> {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    await client.setex(key, seconds, stringValue);
  },

  async setnx(key: string, value: any): Promise<number> {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    return await client.setnx(key, stringValue);
  },

  async del(...keys: string[]): Promise<void> {
    await client.del(...keys);
  },

  async expire(key: string, seconds: number): Promise<void> {
    await client.expire(key, seconds);
  },

  async incr(key: string): Promise<number> {
    return await client.incr(key);
  },

  async incrby(key: string, amount: number): Promise<number> {
    return await client.incrby(key, amount);
  },

  async hgetall<T>(key: string): Promise<T | null> {
    const res = await client.hgetall(key);
    if (!res || Object.keys(res).length === 0) return null;
    
    // Auto-parse all fields
    const parsed: any = {};
    for (const [k, v] of Object.entries(res)) {
      parsed[k] = parseRedisValue(v);
    }
    return parsed as T;
  },

  async hget(key: string, field: string): Promise<string | null> {
    const val = await client.hget(key, field);
    return parseRedisValue(val);
  },

  async hset(key: string, value: Record<string, any>): Promise<void> {
    // ioredis hset supports object, but we should ensure values are stringified if they aren't primitives
    const processed: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      processed[k] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v;
    }
    await client.hset(key, processed);
  },

  async hincrby(key: string, field: string, amount: number): Promise<void> {
    await client.hincrby(key, field, amount);
  },

  async sadd(key: string, ...members: string[]): Promise<void> {
    await client.sadd(key, ...members);
  },

  async smembers(key: string): Promise<string[]> {
    return await client.smembers(key);
  },

  async sismember(key: string, member: string): Promise<number> {
    return await client.sismember(key, member);
  },

  async srem(key: string, member: string): Promise<void> {
    await client.srem(key, member);
  },

  async lpush(key: string, ...values: any[]): Promise<number> {
    const stringValues = values.map(v => (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v);
    return await client.lpush(key, ...stringValues);
  },

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const res = await client.lrange(key, start, stop);
    return res.map(v => parseRedisValue(v));
  },

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await client.ltrim(key, start, stop);
  },

  async zadd(key: string, ...args: any[]): Promise<void> {
    // Handle zadd(key, { score, member }) OR zadd(key, score, member)
    if (args.length === 1 && typeof args[0] === 'object' && 'score' in args[0]) {
      await client.zadd(key, args[0].score, args[0].member);
    } else {
      await client.zadd(key, ...args);
    }
  },

  async zrem(key: string, member: string): Promise<void> {
    await client.zrem(key, member);
  },

  async zscore(key: string, member: string): Promise<number | null> {
    const res = await client.zscore(key, member);
    return res === null ? null : Number(res);
  },

  async zrange<T>(key: string, start: number, stop: number, options?: { rev?: boolean }): Promise<T> {
    let res;
    if (options?.rev) {
      res = await client.zrange(key, start, stop, 'REV');
    } else {
      res = await client.zrange(key, start, stop);
    }
    return res as unknown as T;
  },

  async zcount(key: string, min: number | string, max: number | string): Promise<number> {
    return await client.zcount(key, min, max);
  },

  pipeline() {
    const p = client.pipeline();
    return {
      hgetall(key: string) { p.hgetall(key); return this; },
      hset(key: string, value: any) { 
        const processed: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
          processed[k] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v;
        }
        p.hset(key, processed); 
        return this; 
      },
      zadd(key: string, arg1: any, arg2?: any) { 
        if (typeof arg1 === 'object' && 'score' in arg1) {
            p.zadd(key, arg1.score, arg1.member);
        } else {
            p.zadd(key, arg1, arg2);
        }
        return this; 
      },
      async exec<T>(): Promise<T> {
        const results = await p.exec();
        if (!results) return [] as unknown as T;
        return results.map(r => {
            const val = r[1];
            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                // Potential hgetall result
                const parsed: any = {};
                for (const [k, v] of Object.entries(val)) {
                    parsed[k] = parseRedisValue(v as string);
                }
                return parsed;
            }
            return parseRedisValue(val as string);
        }) as unknown as T;
      }
    };
  }
};
