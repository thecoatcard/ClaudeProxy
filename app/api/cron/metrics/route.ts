import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const reqs = await redis.get('stats:requests');
  if (reqs) {
    await redis.hset('stats:history', { [Date.now().toString()]: reqs });
  }
  
  return NextResponse.json({ success: true });
}
