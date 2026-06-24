/**
 * tests/orchestrator-terminal.test.ts
 *
 * Phase 10 — Test 1: Orchestrator terminal states (Phase 1 + 7)
 */

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      },
      del: async (k: string) => store.delete(k),
      sadd: async () => {},
      smembers: async () => [],
      expire: async () => {},
      srem: async () => {},
      hincrby: async () => 1,
      hincrbyfloat: async () => 1,
      hgetall: async () => null,
    },
  };
});

import {
  createOrchestrationRecord,
  getOrchestrationRecord,
  transitionOrchestrationState,
  finalizeMerge,
  isTerminalState,
  checkAndIncrementLoopCount,
} from '../lib/agent/orchestrator-state';

describe('isTerminalState', () => {
  test('COMPLETED is terminal', () => expect(isTerminalState('COMPLETED')).toBe(true));
  test('FAILED is terminal', () => expect(isTerminalState('FAILED')).toBe(true));
  test('MERGED is terminal', () => expect(isTerminalState('MERGED')).toBe(true));
  test('PENDING is not terminal', () => expect(isTerminalState('PENDING')).toBe(false));
  test('RUNNING is not terminal', () => expect(isTerminalState('RUNNING')).toBe(false));
});

describe('orchestration lifecycle', () => {
  test('creates and reads record with PENDING state', async () => {
    const r = await createOrchestrationRecord('p1', 'u1');
    expect(r.state).toBe('PENDING');
    expect(r.entryCount).toBe(1);
    const loaded = await getOrchestrationRecord('p1');
    expect(loaded).not.toBeNull();
    expect(loaded!.state).toBe('PENDING');
  });

  test('transitions PENDING → RUNNING → MERGED → COMPLETED', async () => {
    await createOrchestrationRecord('p2', 'u1');
    await transitionOrchestrationState('p2', 'RUNNING');
    await transitionOrchestrationState('p2', 'MERGED');
    await transitionOrchestrationState('p2', 'COMPLETED');
    const r = await getOrchestrationRecord('p2');
    expect(r!.state).toBe('COMPLETED');
  });

  test('finalizeMerge persists output and marks COMPLETED', async () => {
    await createOrchestrationRecord('p3', 'u1');
    await transitionOrchestrationState('p3', 'RUNNING');
    await finalizeMerge('p3', 'Final output text');
    const r = await getOrchestrationRecord('p3');
    expect(r!.state).toBe('COMPLETED');
    expect(r!.finalOutput).toBe('Final output text');
  });

  test('terminal state blocks further transitions', async () => {
    await createOrchestrationRecord('p4', 'u1');
    await transitionOrchestrationState('p4', 'COMPLETED');
    await transitionOrchestrationState('p4', 'RUNNING'); // should be ignored
    const r = await getOrchestrationRecord('p4');
    expect(r!.state).toBe('COMPLETED');
  });
});

describe('checkAndIncrementLoopCount', () => {
  test('allows first entry (no record yet)', async () => {
    const result = await checkAndIncrementLoopCount('loop-new');
    expect(result.allowed).toBe(true);
  });

  test('allows up to MAX_LOOP_COUNT=2', async () => {
    await createOrchestrationRecord('loop-1', 'u');
    await transitionOrchestrationState('loop-1', 'RUNNING');
    const r = await checkAndIncrementLoopCount('loop-1');
    expect(r.allowed).toBe(true);
    expect(r.entryCount).toBe(2);
  });

  test('blocks when loop count reaches maximum', async () => {
    await createOrchestrationRecord('loop-2', 'u');
    await transitionOrchestrationState('loop-2', 'RUNNING');
    // Increment to 2
    await checkAndIncrementLoopCount('loop-2');
    // Now at 2 — next attempt should be blocked
    const r = await checkAndIncrementLoopCount('loop-2');
    expect(r.allowed).toBe(false);
  });

  test('blocks on terminal state', async () => {
    await createOrchestrationRecord('loop-3', 'u');
    await transitionOrchestrationState('loop-3', 'COMPLETED');
    const r = await checkAndIncrementLoopCount('loop-3');
    expect(r.allowed).toBe(false);
  });
});
