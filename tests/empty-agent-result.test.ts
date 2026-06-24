jest.mock('../lib/gemini-adapter', () => ({
  callGemini: jest.fn(),
}));

jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'key-1', key: 'test-api-key' }),
}));

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown) => { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      del: async (k: string) => store.delete(k),
      sadd: async (k: string, m: string) => { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k)!.add(m); },
      smembers: async (k: string) => [...(sets.get(k) ?? [])],
      expire: async () => {},
      srem: async (k: string, m: string) => sets.get(k)?.delete(m),
      hincrby: async () => 1,
      hincrbyfloat: async () => 1.0,
      hgetall: async () => null,
    },
  };
});

import { callGemini } from '../lib/gemini-adapter';
import { executeSubagent } from '../lib/agent/subagent-executor';
import { createSubagentTask, saveSubagentTask } from '../lib/agent/subagent-memory';

function emptyResponse() {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: '' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
    }),
  };
}

function textResponse(text: string) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    }),
  };
}

describe('empty agent result detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('empty result triggers fallback model retry', async () => {
    (callGemini as jest.Mock)
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(textResponse('fallback produced output'));

    const task = createSubagentTask({
      parentId: 'parent-1',
      owner: 'user-1',
      description: 'implement a patch',
      model: 'gemini-2.5-flash',
    });
    await saveSubagentTask(task);

    const result = await executeSubagent(task);
    expect(result.success).toBe(true);
    expect(result.retries).toBeGreaterThan(0);
    expect(result.output).toContain('fallback produced output');
    expect((callGemini as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('all-empty results end as failure', async () => {
    (callGemini as jest.Mock).mockResolvedValue(emptyResponse());

    const task = createSubagentTask({
      parentId: 'parent-2',
      owner: 'user-1',
      description: 'verify result',
      model: 'gemini-2.5-flash-lite',
    });
    await saveSubagentTask(task);

    const result = await executeSubagent(task);
    expect(result.success).toBe(false);
    expect(result.error).toContain('EMPTY_SUBAGENT_RESULT');
  });
});
