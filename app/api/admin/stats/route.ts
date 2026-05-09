import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { redis } from '@/lib/redis';
import { cachedAdminResponse } from '@/lib/admin-cache';

export const dynamic = 'force-dynamic';

interface DailyStatRow {
  date: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatency: number;
}

function utcDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function pastUtcDays(days: number): string[] {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const now = new Date();
  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value || now.getUTCFullYear());
  const month = Number(parts.find((p) => p.type === 'month')?.value || (now.getUTCMonth() + 1));
  const day = Number(parts.find((p) => p.type === 'day')?.value || now.getUTCDate());

  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1, day - i));
    out.push(formatter.format(d));
  }
  return out;
}

function toNumber(value: any): number {
  return Math.max(0, Number(value) || 0);
}

function topEntries(obj: Record<string, any> | null | undefined, limit = 8) {
  if (!obj) return [];
  return Object.entries(obj)
    .map(([key, value]) => ({ key, value: toNumber(value) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function avgLatencyMs(latencies: any[]): number {
  if (!Array.isArray(latencies) || latencies.length === 0) return 0;
  const sum = latencies.reduce((acc, cur) => acc + toNumber(cur), 0);
  return Math.round(sum / latencies.length);
}

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const data = await cachedAdminResponse('admin:stats', async () => {
    const today = utcDay();
    const days = pastUtcDays(14);

  const [
    reqs,
    errs,
    inTok,
    outTok,
    lats,
    todayReqs,
    todayErrs,
    todayInTok,
    todayOutTok,
    todayLats,
    modelsReqTotal,
    modelsErrTotal,
    modelsTokTotal,
    todayModelsReq,
    todayModelsErr,
    todayModelsTok,
    todayUsersTok,
  ] = await Promise.all([
    redis.get('stats:requests'),
    redis.get('stats:errors'),
    redis.get('stats:input_tokens'),
    redis.get('stats:output_tokens'),
    redis.lrange('stats:latency', 0, -1),
    redis.get(`stats:daily:${today}:requests`),
    redis.get(`stats:daily:${today}:errors`),
    redis.get(`stats:daily:${today}:input_tokens`),
    redis.get(`stats:daily:${today}:output_tokens`),
    redis.lrange(`stats:daily:${today}:latency`, 0, -1),
    redis.hgetall('stats:models:requests'),
    redis.hgetall('stats:models:errors'),
    redis.hgetall('stats:models:total_tokens'),
    redis.hgetall(`stats:daily:${today}:models:requests`),
    redis.hgetall(`stats:daily:${today}:models:errors`),
    redis.hgetall(`stats:daily:${today}:models:total_tokens`),
    redis.hgetall(`stats:daily:${today}:users:total_tokens`),
  ]);

  const daily: DailyStatRow[] = await Promise.all(
    days.map(async (day) => {
      const [r, e, i, o, lat] = await Promise.all([
        redis.get(`stats:daily:${day}:requests`),
        redis.get(`stats:daily:${day}:errors`),
        redis.get(`stats:daily:${day}:input_tokens`),
        redis.get(`stats:daily:${day}:output_tokens`),
        redis.lrange(`stats:daily:${day}:latency`, 0, -1),
      ]);
      const inputTokens = toNumber(i);
      const outputTokens = toNumber(o);
      return {
        date: day,
        requests: toNumber(r),
        errors: toNumber(e),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        avgLatency: avgLatencyMs(lat as any[]),
      };
    })
  );

  const inputTokens = toNumber(inTok);
  const outputTokens = toNumber(outTok);
  const todayInput = toNumber(todayInTok);
  const todayOutput = toNumber(todayOutTok);

  return {
    requests: toNumber(reqs),
    errors: toNumber(errs),
    avgLatency: avgLatencyMs(lats as any[]),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    today: {
      date: today,
      requests: toNumber(todayReqs),
      errors: toNumber(todayErrs),
      avgLatency: avgLatencyMs(todayLats as any[]),
      inputTokens: todayInput,
      outputTokens: todayOutput,
      totalTokens: todayInput + todayOutput,
    },
    daily,
    topModels: {
      totalRequests: topEntries(modelsReqTotal as any),
      totalErrors: topEntries(modelsErrTotal as any),
      totalTokens: topEntries(modelsTokTotal as any),
      todayRequests: topEntries(todayModelsReq as any),
      todayErrors: topEntries(todayModelsErr as any),
      todayTokens: topEntries(todayModelsTok as any),
    },
    topUsersTodayByTokens: topEntries(todayUsersTok as any),
  };
  }); // end cachedAdminResponse

  return NextResponse.json(data);
}
