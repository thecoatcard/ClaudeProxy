/**
 * tests/performance-tracker.test.ts
 * Tests for performance metrics tracking.
 */

const mockPipeline = {
  lpush: jest.fn().mockReturnThis(),
  ltrim: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  lrange: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([]),
};

jest.mock('../lib/redis', () => ({
  redis: {
    pipeline: jest.fn(() => mockPipeline),
    lpush: jest.fn().mockResolvedValue(1),
    lrange: jest.fn().mockResolvedValue([]),
  },
}));

import { recordMetric, getPerformanceMetrics, startTimer } from '../lib/metrics/performance-tracker';

beforeEach(() => jest.clearAllMocks());

describe('recordMetric', () => {
  test('records metric via pipeline', async () => {
    await recordMetric('ttfb', 150);
    expect(mockPipeline.lpush).toHaveBeenCalledWith(expect.stringContaining('perf:daily:'), '150');
    expect(mockPipeline.ltrim).toHaveBeenCalledWith(expect.any(String), 0, 999);
    expect(mockPipeline.expire).toHaveBeenCalledWith(expect.any(String), 172800);
    expect(mockPipeline.exec).toHaveBeenCalled();
  });

  test('rounds to integer', async () => {
    await recordMetric('routing_latency', 123.7);
    expect(mockPipeline.lpush).toHaveBeenCalledWith(expect.any(String), '124');
  });
});

describe('getPerformanceMetrics', () => {
  test('returns zero metrics when no data', async () => {
    mockPipeline.exec.mockResolvedValue([null, null, null, null, null, null, null]);
    const metrics = await getPerformanceMetrics();
    expect(metrics.ttfb).toEqual({ avg: 0, p50: 0, p95: 0, count: 0 });
    expect(metrics.total_latency).toEqual({ avg: 0, p50: 0, p95: 0, count: 0 });
  });

  test('computes percentiles correctly', async () => {
    const values = Array.from({ length: 100 }, (_, i) => String((i + 1) * 10));
    mockPipeline.exec.mockResolvedValue([
      values, // ttfb
      [], [], [], [], [], [],
    ]);
    const metrics = await getPerformanceMetrics();
    expect(metrics.ttfb.count).toBe(100);
    expect(metrics.ttfb.avg).toBe(505); // (1+2+...+100)*10/100 = 505*10/10 = 505
    expect(metrics.ttfb.p50).toBe(510); // sorted: index 50 → 510
    expect(metrics.ttfb.p95).toBe(960); // index 95 → 960
  });
});

describe('startTimer', () => {
  test('tracks elapsed time', () => {
    const timer = startTimer();
    // elapsed should be ≥ 0
    expect(timer.elapsed()).toBeGreaterThanOrEqual(0);
  });

  test('record fires recordMetric', async () => {
    const timer = startTimer();
    await timer.record('ttfb');
    expect(mockPipeline.lpush).toHaveBeenCalled();
  });
});
