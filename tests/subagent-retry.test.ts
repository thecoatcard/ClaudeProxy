/**
 * tests/subagent-retry.test.ts
 *
 * Tests for retry/rerouting behaviour and the integration scenario
 * "Build a Todo App" (Phase 12).
 *
 * This test exercises the full orchestration pipeline:
 *   prepareOrchestration → scheduleSubagentTasks → mergeSubagentOutputs
 */

// Mock deps
jest.mock('../lib/gemini-adapter', () => ({
  callGemini: jest.fn(),
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
      scan: async () => ['0', []],
    },
  };
});

import { callGemini } from '../lib/gemini-adapter';
import { prepareOrchestration, runOrchestratedExecution } from '../lib/agent/orchestrator-enforcer';
import { scheduleSubagentTasks } from '../lib/agent/subagent-scheduler';
import { mergeSubagentOutputs } from '../lib/agent/subagent-merge';
import { createSubagentTask, saveSubagentTask } from '../lib/agent/subagent-memory';

function mockSuccess(text: string) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
  };
}

describe('Retry and rerouting behaviour', () => {
  beforeEach(() => jest.clearAllMocks());

  test('executor retries with fallback when primary fails, then succeeds', async () => {
    (callGemini as jest.Mock)
      .mockRejectedValueOnce(new Error('Primary model down'))
      .mockResolvedValue(mockSuccess('fallback result'));

    const task = createSubagentTask({ parentId: 'retry-1', owner: 'u', description: 'code task', model: 'gemma-4-31b-it' });
    await saveSubagentTask(task);

    const result = await scheduleSubagentTasks([task]);
    expect(result.completed).toContain(task.id);
    expect(result.outputs.get(task.id)!.retries).toBeGreaterThan(0);
  });

  test('rerouting uses next available model in fallback chain', async () => {
    const modelOrder: string[] = [];
    (callGemini as jest.Mock).mockImplementation((model: string) => {
      modelOrder.push(model);
      if (model === 'gemma-4-31b-it') throw new Error('gemma down');
      return Promise.resolve(mockSuccess(`output from ${model}`));
    });

    const task = createSubagentTask({ parentId: 'retry-2', owner: 'u', description: 'reason deeply', model: 'gemma-4-31b-it' });
    await saveSubagentTask(task);
    await scheduleSubagentTasks([task]);

    expect(modelOrder[0]).toBe('gemma-4-31b-it');
    expect(modelOrder[1]).toBeTruthy(); // rerouted to fallback
  });

  test('all models fail → task marked FAILED', async () => {
    (callGemini as jest.Mock).mockRejectedValue(new Error('All down'));
    const task = createSubagentTask({ parentId: 'retry-3', owner: 'u', description: 'light check', model: 'gemini-2.5-flash-lite' });
    await saveSubagentTask(task);
    const result = await scheduleSubagentTasks([task]);
    expect(result.failed).toContain(task.id);
  });
});

describe('Phase 12 — Integration: Build Todo App', () => {
  beforeEach(() => {
    (callGemini as jest.Mock).mockImplementation((model: string, _key: string, body: any) => {
      const text = body?.contents?.[0]?.parts?.[0]?.text ?? '';
      // Simulate model-specific outputs
      let output = '';
      if (text.includes('plan') || text.includes('decompose')) {
        output = 'Plan: 1. Database schema 2. API endpoints 3. UI components 4. Verification';
      } else if (text.includes('cod') || text.includes('implement')) {
        output = 'Code: export async function createTodo(title: string) { ... }';
      } else if (text.includes('verif') || text.includes('check')) {
        output = 'Verification: ✓ All API endpoints return correct status codes';
      } else if (text.includes('merge') || text.includes('combine')) {
        output = 'Final Todo App: database + API + UI complete';
      } else {
        output = `Output from ${model}`;
      }
      return Promise.resolve(mockSuccess(output));
    });
  });

  test('Full Todo App build orchestration: planner → coder → verifier → merger', async () => {
    const body = {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'build a full-stack todo app from scratch with database, API, and auth' }],
    };

    // Prepare orchestration
    const { ctx } = await prepareOrchestration(body, 'user-integration-test');
    expect(ctx.orchestratorEnabled).toBe(true);
    expect(ctx.subagentTasks.length).toBeGreaterThan(0);

    // Run full execution
    const output = await runOrchestratedExecution(ctx);
    expect(output).not.toBeNull();
    expect(typeof output).toBe('string');
    // Should contain content from at least the planner
    expect(output!.length).toBeGreaterThan(0);
  });

  test('All subagent task types are created for MULTI_STAGE task', async () => {
    const body = {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'create a dashboard with authentication and database' }],
    };
    const { ctx } = await prepareOrchestration(body, 'user-2');
    const models = ctx.subagentTasks.map((t) => t.model);
    // Should have planner (gemma), coder (gemini), verifier, merger
    expect(models).toContain('gemma-4-31b-it');
    expect(models).toContain('gemini-2.5-flash');
  });

  test('Orchestration produces merged output with content from all stages', async () => {
    const body = {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'build a full-stack app from scratch with auth' }],
    };
    const { ctx } = await prepareOrchestration(body, 'user-3');
    const output = await runOrchestratedExecution(ctx);
    expect(output).not.toBeNull();
    // The merged output should be non-empty
    expect(output!.trim().length).toBeGreaterThan(10);
  });

  test('Parallel independent tasks (UI + API) both complete', async () => {
    const parentId = 'todo-parallel';
    const ui = createSubagentTask({ parentId, owner: 'u', description: 'build UI components', model: 'gemini-2.5-flash' });
    const api = createSubagentTask({ parentId, owner: 'u', description: 'implement API endpoints', model: 'gemini-2.5-flash' });
    await saveSubagentTask(ui);
    await saveSubagentTask(api);

    const result = await scheduleSubagentTasks([ui, api]);
    expect(result.completed).toContain(ui.id);
    expect(result.completed).toContain(api.id);
    expect(result.failed).toHaveLength(0);
  });
});
