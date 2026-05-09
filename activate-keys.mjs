// activate-keys.mjs
// Resets all Gemini keys in the pool to healthy status.
// Usage: node activate-keys.mjs
//
// Requires REDIS_URL in .env:
//   REDIS_URL=redis://default:PASSWORD@HOST:PORT

import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Read .env file manually (avoid requiring dotenv dependency).
const env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').split('\n') : [];
let redisUrl = process.env.REDIS_URL || '';
for (const line of env) {
  const trimmed = line.trim();
  if (trimmed.startsWith('REDIS_URL=')) {
    redisUrl = trimmed.slice('REDIS_URL='.length).replace(/^["']|["']$/g, '');
  }
}

if (!redisUrl) {
  console.error('Error: REDIS_URL is not set. Add it to .env or set the environment variable.');
  process.exit(1);
}

const { default: Redis } = await import('ioredis');
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: false,
  lazyConnect: false,
});

redis.on('error', (err) => {
  console.error('[Redis error]', err.message);
});

async function activateAllKeys() {
  console.log(`Connecting to Redis: ${redisUrl.replace(/:[^:@]+@/, ':***@')}`);

  const ids = await redis.zrange('gemini:key_pool', 0, -1);
  if (!ids || ids.length === 0) {
    console.log('No keys found in gemini:key_pool.');
    await redis.quit();
    return;
  }

  console.log(`Found ${ids.length} keys. Activating...`);

  const pipeline = redis.pipeline();
  for (const id of ids) {
    pipeline.hset(`gemini:key:${id}`, {
      status: 'healthy',
      failure_count: 0,
      cooldown_until: 0,
      rpm_used: 0,
    });
    pipeline.zadd('gemini:key_pool', 100, id);
  }

  await pipeline.exec();
  console.log(`Successfully activated ${ids.length} keys!`);
  await redis.quit();
}

activateAllKeys().catch((err) => {
  console.error('Fatal error:', err.message);
  redis.disconnect();
  process.exit(1);
});

