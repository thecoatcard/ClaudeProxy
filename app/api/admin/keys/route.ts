import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { redis } from '@/lib/redis';
import { nanoid } from 'nanoid';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  
  const keys = await redis.zrange('gemini:key_pool', 0, -1);
  if (keys.length === 0) return NextResponse.json({ keys: [] });

  const pipe = redis.pipeline();
  for (const id of keys) pipe.hgetall(`gemini:key:${id}`);
  const pipeResults = await pipe.exec();
  const result = keys.map((id, i) => ({ id, ...(pipeResults[i] as Record<string, string> || {}) }));
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

  // Per-key toggle: ?action=toggle&id=KEY_ID
  if (action === 'toggle') {
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    const data = await redis.hgetall(`gemini:key:${id}`);
    if (!data) return NextResponse.json({ error: 'Key not found' }, { status: 404 });
    const newStatus = data.status === 'disabled' ? 'healthy' : 'disabled';
    const newScore = newStatus === 'healthy' ? 100 : 0;
    await redis.hset(`gemini:key:${id}`, { status: newStatus, failure_count: 0, cooldown_until: 0 });
    await redis.zadd('gemini:key_pool', { score: newScore, member: id });
    return NextResponse.json({ success: true, status: newStatus });
  }

  // Per-key revalidate: ?action=reactivate&id=KEY_ID
  if (action === 'reactivate') {
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    const data = await redis.hgetall(`gemini:key:${id}`);
    if (!data) return NextResponse.json({ error: 'Key not found' }, { status: 404 });
    await redis.hset(`gemini:key:${id}`, { status: 'healthy', failure_count: 0, cooldown_until: 0 });
    await redis.zadd('gemini:key_pool', { score: 100, member: id });
    return NextResponse.json({ success: true, status: 'healthy' });
  }

  if (action !== 'activate-all') {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const ids = await redis.zrange<string[]>('gemini:key_pool', 0, -1);
  if (ids.length === 0) return NextResponse.json({ success: true, activated: 0 });

  // Batch read all keys
  const readPipe = redis.pipeline();
  for (const id of ids) readPipe.hgetall(`gemini:key:${id}`);
  const readResults = await readPipe.exec();

  // Batch write all activations
  const writePipe = redis.pipeline();
  let activated = 0;
  for (let i = 0; i < ids.length; i++) {
    const data = readResults[i] as Record<string, string> | null;
    if (!data || !data.key) continue;
    writePipe.hset(`gemini:key:${ids[i]}`, {
      status: 'healthy',
      failure_count: 0,
      cooldown_until: 0,
    });
    writePipe.zadd('gemini:key_pool', { score: 100, member: ids[i] });
    activated++;
  }
  await writePipe.exec();

  return NextResponse.json({ success: true, activated });
}
