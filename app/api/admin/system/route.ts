/**
 * POST /api/admin/system
 *
 * System control actions for the admin dashboard.
 * Body: { action: string }
 *
 * Actions:
 *   health-check      → ping Redis, return key pool stats
 *   activate-all      → set all provider keys to healthy
 *   clear-failed      → clear failure counters + cooldowns
 *   flush-caches      → delete all gemini:cache:* keys
 *   reset-metrics     → delete all stats:* keys
 *   clear-activity    → delete activity:log
 */
import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { redis } from '@/lib/redis';
import { clearActivity } from '@/lib/activity';

export const dynamic = 'force-dynamic';

async function handleHealthCheck() {
  const start = Date.now();
  let redisOk = false;
  try {
    await redis.ping();
    redisOk = true;
  } catch { /* fall through */ }
  const latencyMs = Date.now() - start;

  const ids = await redis.zrange<string[]>('gemini:key_pool', 0, -1).catch(() => []);
  let healthy = 0, cooldown = 0, revoked = 0, disabled = 0;

  for (const id of ids) {
    const data = await redis.hgetall(`gemini:key:${id}`).catch(() => null);
    if (!data) continue;
    switch (data.status) {
      case 'healthy': healthy++; break;
      case 'cooldown': cooldown++; break;
      case 'revoked': revoked++; break;
      case 'disabled': disabled++; break;
    }
  }

  return {
    redis: { ok: redisOk, latencyMs },
    keyPool: { total: ids.length, healthy, cooldown, revoked, disabled },
    ts: Date.now(),
  };
}

async function handleActivateAll() {
  const ids = await redis.zrange<string[]>('gemini:key_pool', 0, -1).catch(() => []);
  let activated = 0;
  for (const id of ids) {
    const data = await redis.hgetall(`gemini:key:${id}`).catch(() => null);
    if (!data?.key) continue;
    // Don't re-activate disabled or revoked keys.
    if (data.status === 'disabled' || data.status === 'revoked') continue;
    await redis.hset(`gemini:key:${id}`, { status: 'healthy', failure_count: 0, cooldown_until: 0 });
    await redis.zadd('gemini:key_pool', { score: 100, member: id });
    activated++;
  }
  return { activated };
}

async function handleClearFailed() {
  const ids = await redis.zrange<string[]>('gemini:key_pool', 0, -1).catch(() => []);
  let cleared = 0;
  for (const id of ids) {
    const data = await redis.hgetall(`gemini:key:${id}`).catch(() => null);
    if (!data) continue;
    const fc = Number(data.failure_count || 0);
    if (fc > 0 || data.status === 'cooldown') {
      await redis.hset(`gemini:key:${id}`, { failure_count: 0, cooldown_until: 0, status: 'healthy' });
      await redis.zadd('gemini:key_pool', { score: 100, member: id });
      cleared++;
    }
  }
  return { cleared };
}

async function handleFlushCaches() {
  // We scan the key pool for known cache names and delete them.
  // gemini:cache:* keys hold Gemini context cache names.
  // Without a SCAN command in the wrapper, we use a targeted approach.
  // Note: in production, a Redis SCAN would be safer for large datasets.
  let deleted = 0;
  const cacheKeys = await redis.smembers('gemini:cache:index').catch(() => []);
  for (const k of cacheKeys) {
    await redis.del(`gemini:cache:${k}`).catch(() => {});
    deleted++;
  }
  await redis.del('gemini:cache:index').catch(() => {});
  return { deleted };
}

async function handleResetMetrics() {
  const statsKeys = [
    'stats:requests', 'stats:errors', 'stats:input_tokens', 'stats:output_tokens',
    'stats:latency', 'stats:models:requests', 'stats:models:errors', 'stats:models:total_tokens',
  ];
  for (const k of statsKeys) {
    await redis.del(k).catch(() => {});
  }
  // Daily keys for last 30 days
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
  const now = new Date();
  for (let i = 0; i < 30; i++) {
    const d = new Date(now.getTime() - i * 86400_000);
    const day = formatter.format(d);
    const prefix = `stats:daily:${day}`;
    for (const suffix of [':requests', ':errors', ':input_tokens', ':output_tokens', ':latency',
      ':models:requests', ':models:errors', ':models:total_tokens', ':users:total_tokens']) {
      await redis.del(prefix + suffix).catch(() => {});
    }
  }
  return { deleted: statsKeys.length + 30 * 9 };
}

export async function POST(req: Request) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : '';

  switch (action) {
    case 'health-check': {
      const data = await handleHealthCheck();
      return NextResponse.json({ ok: true, data });
    }
    case 'activate-all': {
      const data = await handleActivateAll();
      return NextResponse.json({ ok: true, data });
    }
    case 'clear-failed': {
      const data = await handleClearFailed();
      return NextResponse.json({ ok: true, data });
    }
    case 'flush-caches': {
      const data = await handleFlushCaches();
      return NextResponse.json({ ok: true, data });
    }
    case 'reset-metrics': {
      const data = await handleResetMetrics();
      return NextResponse.json({ ok: true, data });
    }
    case 'clear-activity': {
      await clearActivity();
      return NextResponse.json({ ok: true, data: { cleared: true } });
    }
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const data = await handleHealthCheck();
  return NextResponse.json({ ok: true, data });
}
