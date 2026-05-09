/**
 * tests/gemma-helper.test.ts
 *
 * Tests for the Gemma reasoning helper.
 */

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
};
jest.mock('@/lib/redis', () => ({ redis: mockRedis }));

const mockCallGemini = jest.fn();
jest.mock('@/lib/gemini-adapter', () => ({
  callGemini: (...args: any[]) => mockCallGemini(...args),
}));

const mockGetKey = jest.fn();
jest.mock('@/lib/key-manager', () => ({
  getHealthiestKeyObj: (...args: any[]) => mockGetKey(...args),
}));

import {
  reason,
  reasonCompactionError,
  reasonDependencies,
  reasonContradictions,
  planOverloadCompaction,
} from '@/lib/reasoning/gemma-helper';

describe('GemmaHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null); // no cache
  });

  test('reason returns cached result if available', async () => {
    const cached = {
      output: 'cached answer',
      success: true,
      model: 'gemma-4-31b-it',
      latencyMs: 100,
      cached: false,
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(cached));

    const result = await reason('compaction_error', 'test context');
    expect(result.cached).toBe(true);
    expect(result.output).toBe('cached answer');
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  test('reason returns failure when no API key available', async () => {
    mockGetKey.mockResolvedValue(null);

    const result = await reason('dependency', 'test context');
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
  });

  test('reason calls Gemma model and caches result', async () => {
    mockGetKey.mockResolvedValue({ id: 'key1', key: 'test-key' });
    mockCallGemini.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'reasoning output' }] } }],
      }),
    });
    mockRedis.set.mockResolvedValue('OK');

    const result = await reason('contradiction', 'test context');
    expect(result.success).toBe(true);
    expect(result.output).toBe('reasoning output');
    expect(result.model).toBe('gemma-4-31b-it');
    expect(result.cached).toBe(false);
    expect(mockCallGemini).toHaveBeenCalledWith(
      'gemma-4-31b-it',
      'test-key',
      expect.any(Object),
      false,
    );
    // Should cache the result
    expect(mockRedis.set).toHaveBeenCalled();
  });

  test('reason handles API error gracefully', async () => {
    mockGetKey.mockResolvedValue({ id: 'key1', key: 'test-key' });
    mockCallGemini.mockResolvedValue({ ok: false, status: 503 });

    const result = await reason('overload_planning', 'test');
    expect(result.success).toBe(false);
  });

  test('reason handles thrown error gracefully', async () => {
    mockGetKey.mockResolvedValue({ id: 'key1', key: 'test-key' });
    mockCallGemini.mockRejectedValue(new Error('network error'));

    const result = await reason('compaction_error', 'test');
    expect(result.success).toBe(false);
  });

  test('reasonCompactionError sends error context', async () => {
    mockGetKey.mockResolvedValue({ id: 'key1', key: 'test-key' });
    mockCallGemini.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'fix: retry' }] } }],
      }),
    });

    const result = await reasonCompactionError('timeout', 'compacting messages');
    expect(result.success).toBe(true);
  });

  test('reasonDependencies formats task list', async () => {
    mockGetKey.mockResolvedValue({ id: 'key1', key: 'test-key' });
    mockCallGemini.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"order":[1,2]}' }] } }],
      }),
    });

    const result = await reasonDependencies(['task A', 'task B']);
    expect(result.success).toBe(true);
  });

  test('reasonContradictions detects issues', async () => {
    mockGetKey.mockResolvedValue({ id: 'key1', key: 'test-key' });
    mockCallGemini.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'contradiction found' }] } }],
      }),
    });

    const result = await reasonContradictions(['A is true', 'A is false']);
    expect(result.success).toBe(true);
  });

  test('planOverloadCompaction plans message reduction', async () => {
    mockGetKey.mockResolvedValue({ id: 'key1', key: 'test-key' });
    mockCallGemini.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"keep":[0,1],"drop":[2]}' }] } }],
      }),
    });

    const result = await planOverloadCompaction(['msg1', 'msg2', 'msg3'], 1000);
    expect(result.success).toBe(true);
  });
});
