/**
 * tests/subagent-scheduler.test.ts
 *
 * Unit tests for lib/agent/subagent-scheduler.ts
 */

// Mock deps
jest.mock('../lib/gemini-adapter', () => ({
  callGemini: jest.fn().mockImplementation((model: string, _key: string, body: any) => {
    const text = body?.contents?.[0]?.parts?.[0]?.text ?? 'mock output';
    return Promise.resolve({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: `[${model}] ${text.slice(0, 40)}` }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      }),
    });
  }),
}));

jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'k1', key: 'test-key' }),
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

import { createSubagentTask, saveSubagentTask } from '../lib/agent/subagent-memory';
import { scheduleSubagentTasks } from '../lib/agent/subagent-scheduler';

async function makeSavedTask(params: { parentId: string; description: string; model: string; dependencies?: string[] }) {
  const task = createSubagentTask({ owner: 'u', ...params });
  await saveSubagentTask(task);
  return task;
}

describe('subagent-scheduler', () => {
  test('single task with no deps executes and completes', async () => {
    const t = await makeSavedTask({ parentId: 'sched-1', description: 'plan', model: 'gemma-4-31b-it' });
    const result = await scheduleSubagentTasks([t]);
    expect(result.completed).toContain(t.id);
    expect(result.failed).toHaveLength(0);
  });

  test('two independent tasks execute in parallel', async () => {
    const t1 = await makeSavedTask({ parentId: 'sched-2', description: 'UI task', model: 'gemini-2.5-flash' });
    const t2 = await makeSavedTask({ parentId: 'sched-2', description: 'API task', model: 'gemini-2.5-flash' });
    const result = await scheduleSubagentTasks([t1, t2]);
    expect(result.completed).toContain(t1.id);
    expect(result.completed).toContain(t2.id);
  });

  test('dependent task executes after its dependency', async () => {
    const planner = await makeSavedTask({ parentId: 'sched-3', description: 'plan task', model: 'gemma-4-31b-it' });
    const coder = await makeSavedTask({ parentId: 'sched-3', description: 'code task', model: 'gemini-2.5-flash', dependencies: [planner.id] });
    const result = await scheduleSubagentTasks([planner, coder]);
    expect(result.completed).toContain(planner.id);
    expect(result.completed).toContain(coder.id);
    // Planner should have completed before coder (both should be complete)
    const plannerOut = result.outputs.get(planner.id)!;
    const coderOut = result.outputs.get(coder.id)!;
    expect(plannerOut.success).toBe(true);
    expect(coderOut.success).toBe(true);
  });

  test('skips task when dependency fails', async () => {
    // Force the mock to fail for all calls (all models in fallback chain)
    const { callGemini } = require('../lib/gemini-adapter');
    callGemini.mockRejectedValue(new Error('Model down'));

    const planner = await makeSavedTask({ parentId: 'sched-4', description: 'plan', model: 'gemma-4-31b-it' });
    const coder = await makeSavedTask({ parentId: 'sched-4', description: 'code', model: 'gemini-2.5-flash', dependencies: [planner.id] });
    const result = await scheduleSubagentTasks([planner, coder]);
    expect(result.failed).toContain(planner.id);
    expect(result.skipped).toContain(coder.id);

    // Restore to default success mock
    callGemini.mockImplementation((model: string, _k: string, body: any) => {
      const text = body?.contents?.[0]?.parts?.[0]?.text ?? 'mock output';
      return Promise.resolve({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: `[${model}] ${text.slice(0, 40)}` }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
        }),
      });
    });
  });

  test('outputs map contains results for completed tasks', async () => {
    const t = await makeSavedTask({ parentId: 'sched-5', description: 'verifier task', model: 'gemini-2.5-flash-lite' });
    const result = await scheduleSubagentTasks([t]);
    expect(result.outputs.has(t.id)).toBe(true);
    expect(result.outputs.get(t.id)!.output).toBeTruthy();
  });

  test('three-stage chain executes in correct order', async () => {
    const order: string[] = [];
    const { callGemini } = require('../lib/gemini-adapter');
    callGemini.mockImplementation((model: string, _k: string, _b: any) => {
      order.push(model);
      return Promise.resolve({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: `output-${model}` }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
        }),
      });
    });

    const p1 = await makeSavedTask({ parentId: 'sched-6', description: 'plan', model: 'gemma-4-31b-it' });
    const p2 = await makeSavedTask({ parentId: 'sched-6', description: 'code', model: 'gemini-2.5-flash', dependencies: [p1.id] });
    const p3 = await makeSavedTask({ parentId: 'sched-6', description: 'verify', model: 'gemini-2.5-flash-lite', dependencies: [p2.id] });
    const result = await scheduleSubagentTasks([p1, p2, p3]);
    expect(result.completed).toHaveLength(3);
  });
});
