/**
 * lib/metrics/performance-tracker.ts
 *
 * Track granular performance metrics for observability:
 * - Time to first token (TTFB)
 * - Routing latency (model selection time)
 * - Key race latency
 * - Model race latency
 * - Compaction latency
 * - Total request latency
 *
 * Metrics are stored in Redis with daily aggregation and exposed via
 * the admin stats API.
 */

import { redis } from '../redis';

// IST date formatter
function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export type MetricName =
  | 'ttfb'
  | 'routing_latency'
  | 'key_race_latency'
  | 'model_race_latency'
  | 'compaction_latency'
  | 'total_latency'
  | 'overload_recovery_latency';

/**
 * Record a performance metric value (in ms).
 * Stores both the running average and count for aggregation.
 */
export async function recordMetric(name: MetricName, valueMs: number): Promise<void> {
  const today = todayIST();
  const key = `perf:daily:${today}:${name}`;

  try {
    const pipe = redis.pipeline();
    pipe.lpush(key, String(Math.round(valueMs)));
    pipe.ltrim(key, 0, 999); // keep last 1000 samples per day
    pipe.expire(key, 172_800); // 2-day TTL
    await pipe.exec();
  } catch {
    // Best-effort metrics — never fail a request over metrics
  }
}

/**
 * Get aggregated performance metrics for a given day.
 */
export async function getPerformanceMetrics(date?: string): Promise<Record<MetricName, { avg: number; p50: number; p95: number; count: number }>> {
  const day = date || todayIST();
  const names: MetricName[] = [
    'ttfb', 'routing_latency', 'key_race_latency',
    'model_race_latency', 'compaction_latency', 'total_latency',
    'overload_recovery_latency',
  ];

  const pipe = redis.pipeline();
  for (const name of names) {
    pipe.lrange(`perf:daily:${day}:${name}`, 0, -1);
  }
  const results = await pipe.exec() as (string[] | null)[];

  const metrics: Record<string, { avg: number; p50: number; p95: number; count: number }> = {};

  for (let i = 0; i < names.length; i++) {
    const raw = results[i] as string[] | null;
    if (!raw || raw.length === 0) {
      metrics[names[i]] = { avg: 0, p50: 0, p95: 0, count: 0 };
      continue;
    }

    const values = raw.map(Number).filter(v => !isNaN(v)).sort((a, b) => a - b);
    const count = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / count);
    const p50 = values[Math.floor(count * 0.5)] ?? 0;
    const p95 = values[Math.floor(count * 0.95)] ?? 0;

    metrics[names[i]] = { avg, p50, p95, count };
  }

  return metrics as any;
}

/**
 * Simple request timer helper.
 * Usage:
 *   const timer = startTimer();
 *   // ... do work ...
 *   await timer.record('routing_latency');
 */
export function startTimer(): { elapsed: () => number; record: (name: MetricName) => Promise<void> } {
  const start = Date.now();
  return {
    elapsed: () => Date.now() - start,
    record: async (name: MetricName) => {
      await recordMetric(name, Date.now() - start);
    },
  };
}
