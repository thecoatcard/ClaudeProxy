/**
 * tests/overload-fallback.test.ts
 *
 * Phase 10 — Test 4: Overload triggers immediate fallback to next model
 */

jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'k1', key: 'test-key' }),
}));

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      },
      del: async (k: string) => store.delete(k),
      sadd: async (k: string, m: string) => {
        if (!sets.has(k)) sets.set(k, new Set());
        sets.get(k)!.add(m);
      },
      smembers: async (k: string) => [...(sets.get(k) ?? [])],
      expire: async () => {},
      srem: async () => {},
      hincrby: async () => 1,
      hincrbyfloat: async () => 1,
      hgetall: async () => null,
    },
  };
});

jest.mock('../lib/gemini-adapter', () => ({ callGemini: jest.fn() }));

import { callGemini } from '../lib/gemini-adapter';
import { createSubagentTask, saveSubagentTask } from '../lib/agent/subagent-memory';
import { scheduleSubagentTasks } from '../lib/agent/subagent-scheduler';

function makeSuccessResponse(model: string) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: `output from ${model}` }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
  };
}

describe('Overload fallback (Phase 4)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('immediately skips overloaded model to fallback', async () => {
    const modelsUsed: string[] = [];
    (callGemini as jest.Mock).mockImplementation((model: string) => {
      modelsUsed.push(model);
      if (model === 'gemini-2.5-flash') {
        return Promise.resolve({ ok: false, status: 503, text: async () => 'overloaded_error: The model is currently overloaded' });
      }
      return Promise.resolve(makeSuccessResponse(model));
    });

    const task = createSubagentTask({ parentId: 'ov-1', owner: 'u', description: 'code task', model: 'gemini-2.5-flash' });
    await saveSubagentTask(task);
    const result = await scheduleSubagentTasks([task]);

    // Overloaded primary was skipped — a fallback model was used
    expect(modelsUsed[0]).toBe('gemini-2.5-flash');
    expect(modelsUsed.length).toBeGreaterThan(1); // tried fallback
    expect(result.completed).toContain(task.id);
  });

  test('overload on ALL models marks task FAILED', async () => {
    (callGemini as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'overloaded_error: All overloaded',
    });

    const task = createSubagentTask({ parentId: 'ov-2', owner: 'u', description: 'light check', model: 'gemini-2.5-flash-lite' });
    await saveSubagentTask(task);
    const result = await scheduleSubagentTasks([task]);
    expect(result.failed).toContain(task.id);
  });

  test('first model overloaded, second model succeeds → task COMPLETED', async () => {
    let callCount = 0;
    (callGemini as jest.Mock).mockImplementation((model: string) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: false, status: 429, text: async () => 'quota exceeded' });
      }
      return Promise.resolve(makeSuccessResponse(model));
    });

    const task = createSubagentTask({ parentId: 'ov-3', owner: 'u', description: 'plan and coordinate', model: 'gemma-4-31b-it' });
    await saveSubagentTask(task);
    const result = await scheduleSubagentTasks([task]);
    expect(result.completed).toContain(task.id);
    expect(result.outputs.get(task.id)!.retries).toBeGreaterThan(0);
  });

  test('successful model result is returned correctly', async () => {
    (callGemini as jest.Mock).mockResolvedValue(makeSuccessResponse('gemini-2.5-flash'));

    const task = createSubagentTask({ parentId: 'ov-4', owner: 'u', description: 'implement feature', model: 'gemini-2.5-flash' });
    await saveSubagentTask(task);
    const result = await scheduleSubagentTasks([task]);
    expect(result.completed).toContain(task.id);
    expect(result.outputs.get(task.id)!.success).toBe(true);
  });
});
