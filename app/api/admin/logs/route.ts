/**
 * app/api/admin/logs/route.ts
 *
 * Structured event log API for the observability dashboard.
 * Returns events, timelines, summaries, and model/key observability data.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { getRecentEvents, getRequestEvents, getEventSummary, clearEvents } from '@/lib/logging/event-store';
import { buildTimeline, getRequestDuration, getPhasesSummary } from '@/lib/logging/timeline-builder';
import { getDedupStats } from '@/lib/logging/log-dedup';
import { redis } from '@/lib/redis';
import type { EventCategory, EventSeverity } from '@/lib/logging/event-logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const url = new URL(req.url);
  const view = url.searchParams.get('view') || 'events';

  try {
    switch (view) {
      case 'events': {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
        const category = url.searchParams.get('category') as EventCategory | null;
        const severity = url.searchParams.get('severity') as EventSeverity | null;
        const requestId = url.searchParams.get('requestId') || undefined;
        const search = url.searchParams.get('search') || undefined;

        const events = await getRecentEvents(limit, {
          category: category || undefined,
          severity: severity || undefined,
          requestId,
          search,
        });

        return NextResponse.json({ events, count: events.length });
      }

      case 'timeline': {
        const requestId = url.searchParams.get('requestId');
        if (!requestId) {
          return NextResponse.json({ error: 'requestId required' }, { status: 400 });
        }

        const events = await getRequestEvents(requestId);
        const timeline = buildTimeline(events);
        const duration = getRequestDuration(timeline);
        const phases = getPhasesSummary(timeline);

        return NextResponse.json({ requestId, timeline, duration, phases, eventCount: events.length });
      }

      case 'summary': {
        const summary = await getEventSummary();
        const dedupStats = getDedupStats();
        return NextResponse.json({ summary, dedupStats });
      }

      case 'models': {
        const modelStats = await getModelObservability();
        return NextResponse.json({ models: modelStats });
      }

      case 'keys': {
        const keyStats = await getKeyObservability();
        return NextResponse.json({ keys: keyStats });
      }

      default:
        return NextResponse.json({ error: 'Invalid view. Use: events, timeline, summary, models, keys' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: 'Failed to retrieve logs' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  await clearEvents();
  return NextResponse.json({ success: true });
}

// ─── Model Observability ─────────────────────────────────────────────────────

interface ModelStats {
  model: string;
  requests: number;
  errors: number;
  overloads: number;
  fallbacks: number;
  avgLatencyMs: number;
}

async function getModelObservability(): Promise<ModelStats[]> {
  const models = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it',
  ];

  // Batch all Redis reads in a single pipeline
  const pipe = redis.pipeline();
  for (const model of models) {
    pipe.hget('stats:models:requests', model);
    pipe.hget('stats:models:errors', model);
    pipe.lrange(`stats:model:${model}:latency`, 0, 99);
    pipe.get(`stats:model:${model}:overloads`);
    pipe.get(`stats:model:${model}:fallbacks`);
  }
  const pipeResults = await pipe.exec();

  const results: ModelStats[] = [];
  for (let i = 0; i < models.length; i++) {
    const base = i * 5;
    const requests = parseInt(String(pipeResults[base] || '0'));
    const errors = parseInt(String(pipeResults[base + 1] || '0'));
    const latencies = (pipeResults[base + 2] as string[] || []);
    const overloads = parseInt(String(pipeResults[base + 3] || '0'));
    const fallbacks = parseInt(String(pipeResults[base + 4] || '0'));

    const latencyNums = latencies.map(Number).filter(n => !isNaN(n));
    const avgLatencyMs = latencyNums.length > 0
      ? Math.round(latencyNums.reduce((a, b) => a + b, 0) / latencyNums.length)
      : 0;

    if (requests > 0 || errors > 0) {
      results.push({ model: models[i], requests, errors, overloads, fallbacks, avgLatencyMs });
    }
  }

  return results;
}

// ─── Key Observability ───────────────────────────────────────────────────────

interface KeyStats {
  keyId: string;
  usage: number;
  cooldowns: number;
  restores: number;
  failures: number;
  health: 'healthy' | 'degraded' | 'cooldown';
}

async function getKeyObservability(): Promise<KeyStats[]> {
  // Scan for key health data
  const keyPattern = 'key:health:*';
  const keys: string[] = [];
  let cursor = '0';

  do {
    const [newCursor, found] = await redis.scan(cursor, 'MATCH', keyPattern, 'COUNT', '50');
    cursor = newCursor;
    keys.push(...found);
  } while (cursor !== '0');

  const results: KeyStats[] = [];
  if (keys.length > 0) {
    const pipe = redis.pipeline();
    for (const redisKey of keys) {
      pipe.hgetall(redisKey);
      pipe.exists(`key:cooldown:${redisKey.replace('key:health:', '')}`);
    }
    const pipeResults = await pipe.exec();

    for (let i = 0; i < keys.length; i++) {
      const keyId = keys[i].replace('key:health:', '');
      const data = pipeResults[i * 2] as Record<string, string> | null;
      const isCooling = pipeResults[i * 2 + 1] as number;

      const usage = parseInt(data?.usage || '0');
      const cooldowns = parseInt(data?.cooldowns || '0');
      const restores = parseInt(data?.restores || '0');
      const failures = parseInt(data?.failures || '0');

      results.push({
        keyId: keyId.slice(0, 8) + '…',
        usage,
        cooldowns,
        restores,
        failures,
        health: isCooling ? 'cooldown' : failures > 5 ? 'degraded' : 'healthy',
      });
    }
  }

  return results;
}
