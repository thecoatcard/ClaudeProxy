import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return new Response('Cron authentication is not configured', { status: 503 });
  }
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const reqs = await redis.get('stats:requests');
  if (reqs) {
    await redis.hset('stats:history', { [Date.now().toString()]: reqs });
  }
  
  return NextResponse.json({ success: true });
}
