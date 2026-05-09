/**
 * tests/orchestrator-dedupe.test.ts
 *
 * Phase 10 — Test 3: Deduplication — duplicate requests reuse orchestration
 */

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

import { buildRequestFingerprint, checkOrchestrationDedup, registerOrchestrationFingerprint } from '../lib/agent/orchestrator-lock';
import { createOrchestrationRecord, createSubagentTask as _unused } from '../lib/agent/orchestrator-state';
import { createSubagentTask, saveSubagentTask } from '../lib/agent/subagent-memory';
import { setFingerprintParent, getFingerprintParent } from '../lib/agent/orchestrator-state';

describe('buildRequestFingerprint', () => {
  test('same user + model + message produces same fingerprint', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'hello' }] };
    const fp1 = buildRequestFingerprint('u1', body);
    const fp2 = buildRequestFingerprint('u1', body);
    expect(fp1).toBe(fp2);
  });

  test('different user produces different fingerprint', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'hello' }] };
    const fp1 = buildRequestFingerprint('u1', body);
    const fp2 = buildRequestFingerprint('u2', body);
    expect(fp1).not.toBe(fp2);
  });

  test('different message produces different fingerprint', () => {
    const body1 = { model: 'm', messages: [{ role: 'user', content: 'hello' }] };
    const body2 = { model: 'm', messages: [{ role: 'user', content: 'world' }] };
    const fp1 = buildRequestFingerprint('u1', body1);
    const fp2 = buildRequestFingerprint('u1', body2);
    expect(fp1).not.toBe(fp2);
  });
});

describe('checkOrchestrationDedup', () => {
  test('returns reuse=false when no fingerprint registered', async () => {
    const result = await checkOrchestrationDedup('unknown-fp-xyz');
    expect(result.reuse).toBe(false);
  });

  test('returns reuse=true when active orchestration exists for fingerprint', async () => {
    const parentId = 'dedup-parent-1';
    const fp = 'test-fingerprint-abc';

    // Setup: create active orchestration with tasks
    await createOrchestrationRecord(parentId, 'u');
    const task = createSubagentTask({ parentId, owner: 'u', description: 'plan', model: 'gemma-4-31b-it' });
    await saveSubagentTask(task);
    await registerOrchestrationFingerprint(fp, parentId);

    const result = await checkOrchestrationDedup(fp);
    expect(result.reuse).toBe(true);
    if (result.reuse) {
      expect(result.parentId).toBe(parentId);
      expect(result.tasks.length).toBeGreaterThan(0);
    }
  });
});

describe('fingerprint persistence', () => {
  test('setFingerprintParent and getFingerprintParent roundtrip', async () => {
    await setFingerprintParent('fp-test-123', 'parent-abc');
    const result = await getFingerprintParent('fp-test-123');
    expect(result).toBe('parent-abc');
  });

  test('unknown fingerprint returns null', async () => {
    const result = await getFingerprintParent('does-not-exist');
    expect(result).toBeNull();
  });
});
