import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { redis } from '@/lib/redis';
import { nanoid } from 'nanoid';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const userKeys = await redis.smembers('user:key_set');
  const result = [];
  for (const token of userKeys) {
    const data = await redis.hgetall(`user:key:${token}`);
    result.push({ token, ...data });
  }
  return NextResponse.json({ userKeys: result });
}

export async function POST(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const { name } = await req.json();
  const token = 'ccm_live_' + nanoid(24);
  await redis.hset(`user:key:${token}`, {
    name: name || 'User Key', status: 'active', usage_count: 0, created_at: Math.floor(Date.now() / 1000), last_used: 0
  });
  await redis.sadd('user:key_set', token);
  return NextResponse.json({ success: true, token });
}

export async function DELETE(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (id) {
    await redis.hset(`user:key:${id}`, { status: 'revoked' });
  }
  return NextResponse.json({ success: true });
}

export async function PUT(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const { id, name } = await req.json();
  if (!id || !name) return NextResponse.json({ error: "Missing id or name" }, { status: 400 });
  await redis.hset(`user:key:${id}`, { name });
  return NextResponse.json({ success: true });
}
