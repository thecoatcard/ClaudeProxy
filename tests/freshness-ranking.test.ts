/**
 * tests/freshness-ranking.test.ts
 *
 * Tests for freshness-weighted ranking in the retrieval pipeline.
 */

import { applyFreshnessRanking, computeAdaptiveThreshold } from '@/lib/memory/retrieval-pipeline';
import type { SearchResult } from '@/lib/memory/vector-index';

function makeResult(
  id: string,
  score: number,
  embeddedAt: number,
  type: 'file' | 'task' | 'error' = 'file',
): SearchResult {
  return {
    entry: {
      id,
      vector: [],
      metadata: { type, title: id, text: `content of ${id}`, embeddedAt },
    },
    score,
  };
}

describe('applyFreshnessRanking', () => {
  test('recent entries get boosted above older ones at same similarity', () => {
    const now = Date.now();
    const results: SearchResult[] = [
      makeResult('old.ts', 0.8, now - 7 * 86400000), // 7 days old
      makeResult('new.ts', 0.8, now - 60000),         // 1 minute old
    ];

    const ranked = applyFreshnessRanking(results);
    expect(ranked[0].entry.id).toBe('new.ts');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test('much higher similarity beats freshness', () => {
    const now = Date.now();
    const results: SearchResult[] = [
      makeResult('old-but-relevant.ts', 0.95, now - 7 * 86400000),
      makeResult('new-but-weak.ts', 0.5, now - 60000),
    ];

    const ranked = applyFreshnessRanking(results);
    expect(ranked[0].entry.id).toBe('old-but-relevant.ts');
  });

  test('task/error summaries get extra freshness boost over files', () => {
    const now = Date.now();
    const results: SearchResult[] = [
      makeResult('file.ts', 0.7, now - 3600000, 'file'),
      makeResult('task-summary', 0.7, now - 3600000, 'task'),
    ];

    const ranked = applyFreshnessRanking(results);
    expect(ranked[0].entry.id).toBe('task-summary');
  });

  test('scores are capped at 1.0', () => {
    const now = Date.now();
    const results: SearchResult[] = [
      makeResult('perfect.ts', 0.99, now),
    ];

    const ranked = applyFreshnessRanking(results);
    expect(ranked[0].score).toBeLessThanOrEqual(1.0);
  });

  test('empty results returns empty', () => {
    const ranked = applyFreshnessRanking([]);
    expect(ranked).toEqual([]);
  });

  test('results are sorted by score descending', () => {
    const now = Date.now();
    const results: SearchResult[] = [
      makeResult('c.ts', 0.3, now),
      makeResult('a.ts', 0.9, now),
      makeResult('b.ts', 0.6, now),
    ];

    const ranked = applyFreshnessRanking(results);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });
});

describe('computeAdaptiveThreshold', () => {
  test('very short queries get low threshold', () => {
    expect(computeAdaptiveThreshold('fix bug')).toBeLessThanOrEqual(0.25);
  });

  test('code-specific queries get higher threshold', () => {
    const threshold = computeAdaptiveThreshold('handleSubmit function in UserForm component');
    expect(threshold).toBeGreaterThanOrEqual(0.35);
  });

  test('error queries get moderate threshold', () => {
    const threshold = computeAdaptiveThreshold('fix the authentication error in login flow');
    expect(threshold).toBeGreaterThanOrEqual(0.3);
  });

  test('medium general queries get standard threshold', () => {
    const threshold = computeAdaptiveThreshold('how does the routing work in this project');
    expect(threshold).toBeGreaterThanOrEqual(0.2);
    expect(threshold).toBeLessThanOrEqual(0.4);
  });

  test('single word gets low threshold', () => {
    expect(computeAdaptiveThreshold('deploy')).toBeLessThanOrEqual(0.25);
  });
});
