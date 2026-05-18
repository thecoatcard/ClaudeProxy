/**
 * tests/orchestrator-loop-guard-enforcer.test.ts
 *
 * Ensures prepareOrchestration enforces loop guard on repeated dedup reuse.
 */

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown, opts?: { ex?: number; nx?: boolean }) => {
        if (opts?.nx && store.has(k)) return null;
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

jest.mock('../lib/gemini-adapter', () => ({
  callGemini: jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  }),
}));

jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'k1', key: 'test-key' }),
}));

import { prepareOrchestration } from '../lib/agent/orchestrator-enforcer';

describe('orchestrator enforcer loop guard', () => {
  beforeEach(() => {
    process.env.ENABLE_GATEWAY_ORCHESTRATOR = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_GATEWAY_ORCHESTRATOR;
  });

  test('third identical dedup entry is blocked by loop guard', async () => {
    const body = {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'build a full stack app with auth and database' }],
    };

    const first = await prepareOrchestration(body, 'loop-user-1');
    expect(first.ctx.orchestratorEnabled).toBe(true);

    const second = await prepareOrchestration(body, 'loop-user-1');
    expect(second.ctx.orchestratorEnabled).toBe(true);
    expect(second.ctx.parentId).toBe(first.ctx.parentId);

    const third = await prepareOrchestration(body, 'loop-user-1');
    expect(third.ctx.orchestratorEnabled).toBe(false);
    expect(third.ctx.parentId).toBe(first.ctx.parentId);
  });
});
