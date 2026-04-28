import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const reqs = await redis.get('stats:requests') || 0;
  const errs = await redis.get('stats:errors') || 0;
  const inTok = await redis.get('stats:input_tokens') || 0;
  const outTok = await redis.get('stats:output_tokens') || 0;

  // Calculate average latency
  const lats = await redis.lrange('stats:latency', 0, -1);
  let sum = 0;
  for (const l of lats) sum += Number(l);
  const avgLatency = lats.length ? sum / lats.length : 0;

  const inputTokens = Number(inTok);
  const outputTokens = Number(outTok);

  return NextResponse.json({
    requests: Number(reqs),
    errors: Number(errs),
    avgLatency: Math.round(avgLatency),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  });
}
