/**
 * GET /api/admin/activity
 *
 * Returns the per-request activity log from Redis.
 * Query params:
 *   limit   — max entries to return (default: 100, max: 500)
 *   model   — filter by Claude model alias
 *   status  — filter by 'success' | 'error'
 *   key     — filter by partial masked userKey match
 */
import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { getActivity } from '@/lib/activity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(500, Math.max(1, Number(searchParams.get('limit') || 100)));
  const modelFilter = searchParams.get('model') ?? '';
  const statusFilter = searchParams.get('status') ?? '';
  const keyFilter = searchParams.get('key') ?? '';

  let entries = await getActivity(limit * 3); // Over-fetch so filters don't cut too deep

  if (modelFilter) entries = entries.filter((e) => e.model?.includes(modelFilter));
  if (statusFilter) entries = entries.filter((e) => e.status === statusFilter);
  if (keyFilter) entries = entries.filter((e) => e.userKey?.includes(keyFilter));

  entries = entries.slice(0, limit);

  return NextResponse.json({ entries, total: entries.length });
}

export async function DELETE(req: Request) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const { clearActivity } = await import('@/lib/activity');
  await clearActivity();
  return NextResponse.json({ ok: true });
}
