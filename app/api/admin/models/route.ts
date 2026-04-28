import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { redis } from '@/lib/redis';
import { DEFAULT_MODEL_ROUTING } from '@/lib/model-router';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const registryStr = await redis.get<string>('models:registry');
  let registry = DEFAULT_MODEL_ROUTING;
  if (registryStr && typeof registryStr === 'string') {
    try { registry = JSON.parse(registryStr); } catch(e) {}
  } else if (registryStr && typeof registryStr === 'object') {
    registry = registryStr;
  }
  return NextResponse.json({ models: registry });
}

export async function POST(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const { models } = await req.json();
  await redis.set('models:registry', JSON.stringify(models));
  return NextResponse.json({ success: true });
}
