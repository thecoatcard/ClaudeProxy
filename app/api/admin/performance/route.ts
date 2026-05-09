import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { getPerformanceMetrics } from '@/lib/metrics/performance-tracker';
import { cachedAdminResponse } from '@/lib/admin-cache';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const date = searchParams.get('date') || undefined;

  const data = await cachedAdminResponse(`admin:perf:${date || 'today'}`, async () => {
    return getPerformanceMetrics(date);
  }, 15_000); // 15s cache

  return NextResponse.json(data);
}
