import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { redis } from '@/lib/redis';
import { nanoid } from 'nanoid';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  
  const keys = await redis.zrange('gemini:key_pool', 0, -1);
  const result = [];
  for (const id of keys) {
    const data = await redis.hgetall(`gemini:key:${id}`);
    result.push({ id, ...data });
  }
  return NextResponse.json({ keys: result });
}

export async function POST(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const { key } = await req.json();
  const id = 'key_' + nanoid(10);
  await redis.hset(`gemini:key:${id}`, {
    key, status: 'healthy', rpm_used: 0, tpm_used: 0, daily_used: 0, failure_count: 0, cooldown_until: 0, last_used: 0
  });
  await redis.zadd('gemini:key_pool', { score: 100, member: id });
  return NextResponse.json({ success: true, id });
}

export async function DELETE(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (id) {
    await redis.del(`gemini:key:${id}`);
    await redis.zrem('gemini:key_pool', id);
  }
  return NextResponse.json({ success: true });
}

// Flip every key in the pool back to healthy in one shot — useful after a
// burst of 429/503s has parked most keys in cooldown or after manual revoke.
export async function PATCH(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  if (action !== 'activate-all') {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const ids = await redis.zrange<string[]>('gemini:key_pool', 0, -1);
  let activated = 0;

  for (const id of ids) {
    const data = await redis.hgetall(`gemini:key:${id}`);
    if (!data || !data.key) continue;
    await redis.hset(`gemini:key:${id}`, {
      status: 'healthy',
      failure_count: 0,
      cooldown_until: 0,
    });
    await redis.zadd('gemini:key_pool', { score: 100, member: id });
    activated++;
  }

  return NextResponse.json({ success: true, activated });
}
