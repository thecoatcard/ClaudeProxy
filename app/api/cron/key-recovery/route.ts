import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { GeminiKey } from '@/lib/key-manager';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const keys = await redis.zrange<string[]>('gemini:key_pool', 0, -1);
  const now = Math.floor(Date.now() / 1000);
  let recovered = 0;

  for (const id of keys) {
    const data = await redis.hgetall(`gemini:key:${id}`) as unknown as GeminiKey | null;
    if (!data) continue;
    if (data.status === 'cooldown' && Number(data.cooldown_until || 0) <= now) {
      await redis.hset(`gemini:key:${id}`, {
        status: 'healthy',
        failure_count: 0,
        cooldown_until: 0,
      });
      const rpmUsed = Number(data.rpm_used || 0);
      await redis.zadd('gemini:key_pool', { score: 100 - rpmUsed, member: id });
      recovered++;
    }
  }

  return NextResponse.json({ success: true, recovered });
}
