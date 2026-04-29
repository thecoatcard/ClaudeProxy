import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startTime = Date.now();
  try {
    // 1. Check Redis
    await redis.get('health:check');
    const redisLatency = Date.now() - startTime;

    // 2. Check Key Pool
    const keyCount = await redis.zcount('gemini:key_pool', 0, 100);
    const healthyCount = await redis.zcount('gemini:key_pool', 50, 100);

    return NextResponse.json({
      status: 'healthy',
      version: '1.2.0',
      uptime: process.uptime(),
      redis: {
        status: 'connected',
        latency_ms: redisLatency,
        total_keys: keyCount,
        healthy_keys: healthyCount
      },
      config: {
        model: process.env.DEFAULT_MODEL || 'gemini-3.1-flash-lite-preview',
        cache_enabled: process.env.GEMINI_CACHE_ENABLED === 'true'
      }
    });
  } catch (err: any) {
    return NextResponse.json({
      status: 'degraded',
      error: err.message
    }, { status: 503 });
  }
}
