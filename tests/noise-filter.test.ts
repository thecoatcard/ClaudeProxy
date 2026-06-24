/**
 * tests/noise-filter.test.ts
 *
 * Tests for noise filtering.
 */

import { shouldFilter, isNoisyLogLine } from '@/lib/logging/noise-filter';
import type { EventLog } from '@/lib/logging/event-logger';

function makeEvent(event: string, category = 'SYSTEM'): EventLog {
  return {
    id: 'evt_test',
    category: category as any,
    event,
    severity: 'INFO',
    timestamp: Date.now(),
  };
}

describe('NoiseFilter', () => {
  describe('shouldFilter', () => {
    test('filters Next.js static asset requests', () => {
      expect(shouldFilter(makeEvent('GET /_next/static/chunks/main.js'))).toBe(true);
      expect(shouldFilter(makeEvent('GET /_next/image?url=/bg.png'))).toBe(true);
    });

    test('filters Next.js dev server logs', () => {
      expect(shouldFilter(makeEvent('GET /__nextjs_original-stack-frame'))).toBe(true);
    });

    test('filters admin polling requests', () => {
      expect(shouldFilter(makeEvent('GET /api/admin/stats'))).toBe(true);
      expect(shouldFilter(makeEvent('admin stats polling'))).toBe(true);
    });

    test('filters health checks', () => {
      expect(shouldFilter(makeEvent('healthcheck passed'))).toBe(true);
      expect(shouldFilter(makeEvent('readiness probe'))).toBe(true);
    });

    test('filters browser warnings', () => {
      expect(shouldFilter(makeEvent('[HMR] connected'))).toBe(true);
      expect(shouldFilter(makeEvent('[webpack] updating'))).toBe(true);
      expect(shouldFilter(makeEvent('[Fast Refresh] rebuilding'))).toBe(true);
    });

    test('does NOT filter real events', () => {
      expect(shouldFilter(makeEvent('Model resolved to gemini-2.5-flash'))).toBe(false);
      expect(shouldFilter(makeEvent('Retry attempt 3 with fallback model'))).toBe(false);
      expect(shouldFilter(makeEvent('Key rotated due to 429'))).toBe(false);
      expect(shouldFilter(makeEvent('Request completed in 2500ms'))).toBe(false);
    });
  });

  describe('isNoisyLogLine', () => {
    test('detects noisy raw log lines', () => {
      expect(isNoisyLogLine('GET /_next/static/css/app.css 200 in 3ms')).toBe(true);
      expect(isNoisyLogLine('[HMR] connected')).toBe(true);
    });

    test('passes real log lines', () => {
      expect(isNoisyLogLine('[retry] Attempting model gemini-2.5-flash')).toBe(false);
      expect(isNoisyLogLine('Error: 429 Rate limit exceeded')).toBe(false);
    });
  });
});
