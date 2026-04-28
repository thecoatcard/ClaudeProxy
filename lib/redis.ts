import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.REDIS_URL || 'http://localhost:8080',
  token: process.env.REDIS_TOKEN || 'test-token',
});
