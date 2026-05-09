/**
 * tests/dashboard-metrics.test.ts
 *
 * Tests for stats & activity API response shapes and transformation logic.
 * Run: npx tsx --test tests/dashboard-metrics.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
// Type definitions matching API response shapes
// ─────────────────────────────────────────────────────────────────────────────

type ActivityEntry = {
  ts: number;
  keyId: string;
  model: string;
  geminiModel?: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: 'ok' | 'error' | 'rate_limited';
  stream?: boolean;
  fallback?: boolean;
  retries?: number;
  toolCalls?: number;
  flags?: string[];
};

type KV = { key: string; value: number };

type StatsResponse = {
  requests: number;
  errors: number;
  avgLatency: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  today: {
    date: string;
    requests: number;
    errors: number;
    avgLatency: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  daily: Array<{
    date: string;
    requests: number;
    errors: number;
    avgLatency: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
  topModels: {
    totalRequests: KV[];
    totalErrors: KV[];
    totalTokens: KV[];
    todayRequests: KV[];
    todayErrors: KV[];
    todayTokens: KV[];
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers that mirror frontend display logic
// ─────────────────────────────────────────────────────────────────────────────

function compact(v: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function percent(a: number, b: number): string {
  if (!b) return '0%';
  return `${((a / b) * 100).toFixed(2)}%`;
}

function filterActivity(entries: ActivityEntry[], opts: {
  search?: string;
  model?: string;
  status?: string;
}): ActivityEntry[] {
  return entries.filter((e) => {
    if (opts.search && !e.keyId.toLowerCase().includes(opts.search.toLowerCase())) return false;
    if (opts.model && e.model !== opts.model) return false;
    if (opts.status && e.status !== opts.status) return false;
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats shape tests
// ─────────────────────────────────────────────────────────────────────────────

describe('StatsResponse shape validation', () => {
  const sample: StatsResponse = {
    requests: 1200,
    errors: 45,
    avgLatency: 1230,
    inputTokens: 500_000,
    outputTokens: 200_000,
    totalTokens: 700_000,
    today: {
      date: '2025-07-01',
      requests: 120,
      errors: 5,
      avgLatency: 980,
      inputTokens: 50_000,
      outputTokens: 20_000,
      totalTokens: 70_000,
    },
    daily: [
      { date: '2025-06-30', requests: 100, errors: 3, avgLatency: 1100, inputTokens: 40_000, outputTokens: 15_000, totalTokens: 55_000 },
    ],
    topModels: {
      totalRequests: [{ key: 'gemini-1.5-pro', value: 800 }],
      totalErrors: [{ key: 'gemini-1.5-pro', value: 20 }],
      totalTokens: [{ key: 'gemini-1.5-pro', value: 500_000 }],
      todayRequests: [{ key: 'gemini-1.5-pro', value: 90 }],
      todayErrors: [{ key: 'gemini-1.5-pro', value: 2 }],
      todayTokens: [{ key: 'gemini-1.5-pro', value: 60_000 }],
    },
  };

  it('has required top-level fields', () => {
    assert.ok('requests' in sample);
    assert.ok('errors' in sample);
    assert.ok('avgLatency' in sample);
    assert.ok('totalTokens' in sample);
  });

  it('today is a subset of totals', () => {
    assert.ok(sample.today.requests <= sample.requests);
    assert.ok(sample.today.totalTokens <= sample.totalTokens);
  });

  it('daily array has correct shape', () => {
    for (const day of sample.daily) {
      assert.ok('date' in day);
      assert.ok('requests' in day);
      assert.ok('totalTokens' in day);
    }
  });

  it('topModels has all 6 sub-arrays', () => {
    const keys = Object.keys(sample.topModels);
    assert.ok(keys.includes('totalRequests'));
    assert.ok(keys.includes('todayTokens'));
    assert.equal(keys.length, 6);
  });
});

describe('Display format helpers', () => {
  it('compact formats large numbers', () => {
    assert.equal(compact(1000), '1K');
    assert.equal(compact(1_500_000), '1.5M');
  });

  it('percent returns 0% when denominator is 0', () => {
    assert.equal(percent(10, 0), '0%');
  });

  it('percent computes correctly', () => {
    assert.equal(percent(1, 4), '25.00%');
  });

  it('relativeTime returns just now for recent entries', () => {
    assert.equal(relativeTime(Date.now() - 5000), 'just now');
  });

  it('relativeTime returns minutes ago', () => {
    const result = relativeTime(Date.now() - 120_000);
    assert.ok(result.includes('m ago'));
  });

  it('relativeTime returns hours ago', () => {
    const result = relativeTime(Date.now() - 7_200_000);
    assert.ok(result.includes('h ago'));
  });
});

describe('Activity filtering logic', () => {
  const entries: ActivityEntry[] = [
    { ts: Date.now(), keyId: 'abc-123', model: 'claude-3-haiku', geminiModel: 'gemini-flash', inputTokens: 100, outputTokens: 50, latencyMs: 500, status: 'ok', stream: true },
    { ts: Date.now(), keyId: 'def-456', model: 'claude-sonnet', geminiModel: 'gemini-1.5-pro', inputTokens: 200, outputTokens: 100, latencyMs: 1200, status: 'error', fallback: true },
    { ts: Date.now(), keyId: 'abc-789', model: 'claude-3-haiku', geminiModel: 'gemini-flash', inputTokens: 50, outputTokens: 25, latencyMs: 300, status: 'ok' },
  ];

  it('filters by keyId search', () => {
    const filtered = filterActivity(entries, { search: 'abc' });
    assert.equal(filtered.length, 2);
  });

  it('filters by model', () => {
    const filtered = filterActivity(entries, { model: 'claude-3-haiku' });
    assert.equal(filtered.length, 2);
  });

  it('filters by status', () => {
    const filtered = filterActivity(entries, { status: 'error' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].keyId, 'def-456');
  });

  it('combines search + model + status filters', () => {
    const filtered = filterActivity(entries, { search: 'abc', model: 'claude-3-haiku', status: 'ok' });
    assert.equal(filtered.length, 2);
  });

  it('returns empty array when nothing matches', () => {
    const filtered = filterActivity(entries, { search: 'zzz' });
    assert.equal(filtered.length, 0);
  });

  it('extracts unique models from entries', () => {
    const models = [...new Set(entries.map((e) => e.model))];
    assert.equal(models.length, 2);
    assert.ok(models.includes('claude-3-haiku'));
    assert.ok(models.includes('claude-sonnet'));
  });
});

describe('KPI card coloring thresholds', () => {
  function errorRateClass(errors: number, total: number): string {
    if (!total) return '';
    const rate = errors / total;
    if (rate > 0.05) return 'kpi-card-bad';
    if (rate > 0.02) return 'kpi-card-warn';
    return 'kpi-card-ok';
  }

  it('flags high error rate as bad', () => {
    assert.equal(errorRateClass(60, 100), 'kpi-card-bad');
  });

  it('flags moderate error rate as warn', () => {
    assert.equal(errorRateClass(3, 100), 'kpi-card-warn');
  });

  it('flags low error rate as ok', () => {
    assert.equal(errorRateClass(1, 100), 'kpi-card-ok');
  });

  it('returns empty string when no requests', () => {
    assert.equal(errorRateClass(0, 0), '');
  });
});
