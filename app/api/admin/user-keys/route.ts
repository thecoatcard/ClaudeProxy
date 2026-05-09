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
  const { name, rpm_limit, max_usage, notes, expires_at } = await req.json();
  const token = 'ccm_live_' + nanoid(24);
  await redis.hset(`user:key:${token}`, {
    name: name || 'User Key',
    status: 'active',
    usage_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    rpm_limit: Number(rpm_limit || 0),
    max_usage: Number(max_usage || 0),
    notes: notes || '',
    expires_at: expires_at ? Math.floor(new Date(expires_at).getTime() / 1000) : 0,
    created_at: Math.floor(Date.now() / 1000),
    last_used: 0
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
  const { id, name, rpm_limit, max_usage, notes, expires_at, status } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (rpm_limit !== undefined) updates.rpm_limit = Number(rpm_limit);
  if (max_usage !== undefined) updates.max_usage = Number(max_usage);
  if (notes !== undefined) updates.notes = notes;
  if (expires_at !== undefined) updates.expires_at = expires_at ? Math.floor(new Date(expires_at).getTime() / 1000) : 0;
  if (status !== undefined && ['active', 'disabled', 'revoked'].includes(status)) updates.status = status;
  if (!Object.keys(updates).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  await redis.hset(`user:key:${id}`, updates as Record<string, string | number>);
  return NextResponse.json({ success: true });
}
