/**
 * tests/orchestrator-resume-continuity.test.ts
 *
 * Regression tests for deterministic resume behavior.
 */

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
      set: async (k: string, v: unknown) => {
        store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
        return 'OK';
      },
      del: async (...keys: string[]) => {
        for (const key of keys) store.delete(key);
        return 1;
      },
      sadd: async (k: string, m: string) => {
        if (!sets.has(k)) sets.set(k, new Set());
        sets.get(k)!.add(m);
      },
      smembers: async (k: string) => [...(sets.get(k) ?? [])],
      expire: async () => {},
      srem: async (k: string, m: string) => sets.get(k)?.delete(m),
      hincrby: async () => 1,
      hincrbyfloat: async () => 1,
      hgetall: async () => null,
      scan: async () => ['0', []],
    },
  };
});

import { callGemini } from '../lib/gemini-adapter';
import { createSubagentTask, saveSubagentTask } from '../lib/agent/subagent-memory';
import { resumeOrchestratedExecution, type OrchestratorContext } from '../lib/agent/orchestrator-enforcer';

function successPayload(text: string) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 20 },
    }),
  };
}

describe('orchestrator resume continuity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_GATEWAY_ORCHESTRATOR = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_GATEWAY_ORCHESTRATOR;
  });

  test('resumes pending work without re-running completed dependency', async () => {
    (callGemini as jest.Mock).mockResolvedValue(successPayload('coder-output'));

    const parentId = 'resume-parent-1';
    const planner = createSubagentTask({
      parentId,
      owner: 'u1',
      description: 'plan architecture',
      model: 'gemma-4-31b-it',
      dependencies: [],
    });
    planner.status = 'COMPLETED';
    planner.execution = {
      model: planner.model,
      output: 'planner-output',
      inputTokens: 12,
      outputTokens: 8,
      latencyMs: 40,
      retries: 0,
      success: true,
      updatedAt: Date.now(),
    };

    const coder = createSubagentTask({
      parentId,
      owner: 'u1',
      description: 'implement code',
      model: 'gemini-2.5-flash',
      dependencies: [planner.id],
    });
    coder.status = 'PENDING';

    await saveSubagentTask(planner);
    await saveSubagentTask(coder);

    const ctx: OrchestratorContext = {
      parentId,
      complexity: {
        level: 'COMPLEX',
        reason: 'test',
        orchestratorRequired: true,
        explicitOverride: true,
      },
      subagentTasks: [planner, coder],
      orchestratorEnabled: true,
      systemPromptInjected: true,
    };

    const output = await resumeOrchestratedExecution(ctx);
    expect(output).toContain('planner-output');
    expect(output).toContain('coder-output');
    expect(callGemini).toHaveBeenCalledTimes(1);
  });

  test('rebuilds output from persisted checkpoints when all tasks are already complete', async () => {
    const parentId = 'resume-parent-2';

    const planner = createSubagentTask({
      parentId,
      owner: 'u2',
      description: 'plan architecture',
      model: 'gemma-4-31b-it',
      dependencies: [],
    });
    planner.status = 'COMPLETED';
    planner.execution = {
      model: planner.model,
      output: 'planner-complete',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 30,
      retries: 0,
      success: true,
      updatedAt: Date.now(),
    };

    const verifier = createSubagentTask({
      parentId,
      owner: 'u2',
      description: 'verify implementation',
      model: 'gemini-2.5-flash-lite',
      dependencies: [planner.id],
    });
    verifier.status = 'COMPLETED';
    verifier.execution = {
      model: verifier.model,
      output: 'verifier-complete',
      inputTokens: 9,
      outputTokens: 4,
      latencyMs: 25,
      retries: 0,
      success: true,
      updatedAt: Date.now(),
    };

    await saveSubagentTask(planner);
    await saveSubagentTask(verifier);

    const ctx: OrchestratorContext = {
      parentId,
      complexity: {
        level: 'COMPLEX',
        reason: 'test',
        orchestratorRequired: true,
        explicitOverride: true,
      },
      subagentTasks: [planner, verifier],
      orchestratorEnabled: true,
      systemPromptInjected: true,
    };

    const output = await resumeOrchestratedExecution(ctx);
    expect(output).toContain('planner-complete');
    expect(output).toContain('verifier-complete');
    expect(callGemini).not.toHaveBeenCalled();
  });
});
