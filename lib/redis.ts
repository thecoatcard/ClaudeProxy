// Thin re-export — all Redis operations now go through the ioredis-based wrapper.
export { redis } from './redis/client';
export type { RedisClient } from './redis/client';
