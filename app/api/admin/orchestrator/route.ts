/**
 * app/api/admin/orchestrator/route.ts
 *
 * Orchestrator dashboard API.
 * Returns live subagent execution stats and performance metrics.
 */

import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { getSubagentTasksByParent } from '@/lib/agent/subagent-memory';
import { getPerformanceSummary } from '@/lib/agent/subagent-performance';
import { redis } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODELS = [
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

const TASK_TYPES = ['PLANNER', 'CODER', 'VERIFIER', 'MERGER', 'GENERIC'] as const;

/** List recent parent orchestration IDs from the active task index. */
async function getRecentParentIds(): Promise<string[]> {
  try {
    // We scan for recent subagent:parent:* keys (lightweight — TTL 24h means old ones expire)
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await (redis as any).scan(cursor, 'MATCH', 'subagent:parent:*', 'COUNT', 50).catch(() => ['0', []]);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0' && keys.length < 20);
    return keys.map((k: string) => k.replace('subagent:parent:', '')).slice(0, 20);
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const isValid = await validateAdminKey(req).catch(() => false);
  if (!isValid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Performance metrics per model × task type ──────────────────────────────
  const perfRows = await Promise.all(
    MODELS.flatMap((model) =>
      TASK_TYPES.map(async (taskType) => {
        const summary = await getPerformanceSummary(model, taskType);
        return summary ? { ...summary } : null;
      })
    )
  );
  const performance = perfRows.filter(Boolean);

  // ── Recent orchestration sessions ─────────────────────────────────────────
  const parentIds = await getRecentParentIds();
  const sessions = await Promise.all(
    parentIds.map(async (parentId) => {
      const tasks = await getSubagentTasksByParent(parentId).catch(() => []);
      const completed = tasks.filter((t) => t.status === 'COMPLETED').length;
      const failed = tasks.filter((t) => t.status === 'FAILED').length;
      const pending = tasks.filter((t) => t.status === 'PENDING' || t.status === 'RUNNING').length;
      return {
        parentId,
        totalTasks: tasks.length,
        completed,
        failed,
        pending,
        tasks: tasks.map((t) => ({
          id: t.id,
          description: t.description,
          model: t.model,
          status: t.status,
          latencyMs: t.completedAt ? t.completedAt - t.createdAt : null,
          artifacts: t.artifacts,
          dependencies: t.dependencies,
        })),
      };
    })
  );

  return NextResponse.json({
    ok: true,
    sessions: sessions.filter((s) => s.totalTasks > 0),
    performance,
    generatedAt: new Date().toISOString(),
  });
}
