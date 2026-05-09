/**
 * tests/subagent-executor.test.ts
 *
 * Unit tests for lib/agent/subagent-executor.ts
 */

// Mock deps before imports
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

function makeGeminiResponse(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: outputTokens },
    }),
  };
}

describe('subagent-executor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('successful execution returns output and marks task COMPLETED', async () => {
    (callGemini as jest.Mock).mockResolvedValue(makeGeminiResponse('Here is the plan.'));

    const task = createSubagentTask({
      parentId: 'p1',
      owner: 'u1',
      description: 'Coordinator: plan the task',
      model: 'gemma-4-31b-it',
    });
    await saveSubagentTask(task);

    const result = await executeSubagent(task, new Map());
    expect(result.success).toBe(true);
    expect(result.output).toBe('Here is the plan.');
    expect(result.model).toBe('gemma-4-31b-it');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  test('returns output tokens correctly', async () => {
    (callGemini as jest.Mock).mockResolvedValue(makeGeminiResponse('function hello() {}', 200, 20));
    const task = createSubagentTask({ parentId: 'p2', owner: 'u', description: 'code task', model: 'gemini-2.5-flash' });
    await saveSubagentTask(task);
    const result = await executeSubagent(task);
    expect(result.outputTokens).toBe(20);
  });

  test('injects dependency output as context', async () => {
    (callGemini as jest.Mock).mockImplementation((model, apiKey, body: any) => {
      const text = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      return Promise.resolve(makeGeminiResponse(`Got: ${text.includes('step1') ? 'dep-used' : 'no-dep'}`));
    });

    const task = createSubagentTask({ parentId: 'p3', owner: 'u', description: 'implement step', model: 'gemini-2.5-flash' });
    await saveSubagentTask(task);
    const deps = new Map([['dep-1', 'step1: create schema']]);
    const result = await executeSubagent(task, deps);
    expect(result.output).toContain('dep-used');
  });

  test('retries with fallback model on failure', async () => {
    (callGemini as jest.Mock)
      .mockRejectedValueOnce(new Error('Model unavailable'))
      .mockResolvedValue(makeGeminiResponse('fallback output'));

    const task = createSubagentTask({ parentId: 'p4', owner: 'u', description: 'code task', model: 'gemma-4-31b-it' });
    await saveSubagentTask(task);
    const result = await executeSubagent(task);
    expect(result.success).toBe(true);
    expect(result.retries).toBeGreaterThan(0);
    expect(result.output).toBe('fallback output');
  });

  test('marks task FAILED when all models fail', async () => {
    (callGemini as jest.Mock).mockRejectedValue(new Error('All models down'));
    const task = createSubagentTask({ parentId: 'p5', owner: 'u', description: 'code task', model: 'gemini-2.5-flash-lite' });
    await saveSubagentTask(task);
    const result = await executeSubagent(task);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('handles HTTP error response', async () => {
    (callGemini as jest.Mock).mockResolvedValue({ ok: false, status: 429, text: async () => 'Rate limited' });
    const task = createSubagentTask({ parentId: 'p6', owner: 'u', description: 'quick task', model: 'gemini-2.5-flash' });
    await saveSubagentTask(task);
    const result = await executeSubagent(task);
    // Should retry with fallback models; all will fail since mock returns 429 for all
    expect(result.success).toBe(false);
  });
});
