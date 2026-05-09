/**
 * lib/agent/subagent-performance.ts
 *
 * Redis-backed performance memory for subagent model calls.
 * Tracks: success rate, latency, failure rate per (model × task type).
 * Used by Phase 8 (smart routing) to prefer high-performing models.
 */

import { redis } from '@/lib/redis';

export type SubagentRole = 'PLANNER' | 'CODER' | 'VERIFIER' | 'MERGER' | 'GENERIC';

export interface PerformanceRecord {
  model: string;
  taskType: SubagentRole;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  success: boolean;
}

export interface PerformanceSummary {
  model: string;
  taskType: SubagentRole;
  totalCalls: number;
  successRate: number;   // 0–1
  avgLatencyMs: number;
  avgTokens: number;
  failureRate: number;   // 0–1
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

const PERF_KEY_PREFIX = 'subagent:perf';
const PERF_TTL = 7 * 86_400; // 7 days

function perfKey(model: string, taskType: SubagentRole): string {
  return `${PERF_KEY_PREFIX}:${model}:${taskType}`;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Append a single performance record.
 * Stored as a Redis Hash with running counters.
 */
export async function recordSubagentPerformance(record: PerformanceRecord): Promise<void> {
  try {
    const key = perfKey(record.model, record.taskType);
    const r = redis as any;

    await r.hincrby(key, 'total_calls', 1).catch(() => {});
    await r.hincrbyfloat(key, 'total_latency_ms', record.latencyMs).catch(() => {});
    await r.hincrby(key, 'total_tokens', record.inputTokens + record.outputTokens).catch(() => {});
    if (record.success) {
      await r.hincrby(key, 'success_count', 1).catch(() => {});
    } else {
      await r.hincrby(key, 'failure_count', 1).catch(() => {});
    }
    await r.expire(key, PERF_TTL).catch(() => {});
  } catch {
    // Best-effort
  }
}

/**
 * Read performance summary for a (model × taskType) pair.
 */
export async function getPerformanceSummary(
  model: string,
  taskType: SubagentRole
): Promise<PerformanceSummary | null> {
  try {
    const key = perfKey(model, taskType);
    const data = await (redis as any).hgetall(key).catch(() => null);
    if (!data) return null;

    const totalCalls = Number(data.total_calls ?? 0);
    if (totalCalls === 0) return null;

    const successCount = Number(data.success_count ?? 0);
    const failureCount = Number(data.failure_count ?? 0);
    const totalLatency = Number(data.total_latency_ms ?? 0);
    const totalTokens = Number(data.total_tokens ?? 0);

    return {
      model,
      taskType,
      totalCalls,
      successRate: successCount / totalCalls,
      avgLatencyMs: totalLatency / totalCalls,
      avgTokens: totalTokens / totalCalls,
      failureRate: failureCount / totalCalls,
    };
  } catch {
    return null;
  }
}

/**
 * Given a list of candidate models for a task type, return them sorted by
 * best performance (highest success rate, then lowest latency).
 * Models with no history retain their original order.
 */
export async function rankModelsByPerformance(
  models: string[],
  taskType: SubagentRole
): Promise<string[]> {
  const summaries = await Promise.all(
    models.map((m) => getPerformanceSummary(m, taskType))
  );

  // Assign a score: success_rate * 1000 - avg_latency_ms / 1000
  // (higher is better)
  const scored = models.map((m, i) => {
    const s = summaries[i];
    const score = s
      ? s.successRate * 1000 - s.avgLatencyMs / 1000
      : 0; // no history → neutral
    return { model: m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.model);
}
