/**
 * tests/subagent-memory.test.ts
 *
 * Unit tests for lib/agent/subagent-memory.ts
 */

// Stub out ioredis before any module imports
jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  return {
    redis: {
      async get(key: string) { return store.get(key) ?? null; },
      async set(key: string, value: unknown, _opts?: { ex?: number }) {
        store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      },
      async del(key: string) { store.delete(key); },
      async sadd(key: string, member: string) {
        if (!sets.has(key)) sets.set(key, new Set());
        sets.get(key)!.add(member);
      },
      async smembers(key: string) { return Array.from(sets.get(key) ?? []); },
      async expire() {},
      async srem(key: string, member: string) { sets.get(key)?.delete(member); },
    },
  };
});

import {
  createSubagentTask,
  saveSubagentTask,
  getSubagentTask,
  getSubagentTasksByParent,
  updateSubagentStatus,
  deleteSubagentTask,
} from '../lib/agent/subagent-memory';

describe('subagent-memory', () => {
  test('createSubagentTask produces a valid record', () => {
    const task = createSubagentTask({
      parentId: 'parent-1',
      owner: 'user-1',
      description: 'Do something',
      model: 'gemini-2.5-flash',
    });
    expect(task.id).toBeTruthy();
    expect(task.status).toBe('PENDING');
    expect(task.artifacts).toEqual([]);
    expect(task.completedAt).toBeNull();
  });

  test('saveSubagentTask and getSubagentTask roundtrip', async () => {
    const task = createSubagentTask({
      parentId: 'parent-2',
      owner: 'user-1',
      description: 'Test task',
      model: 'gemini-2.5-flash',
    });
    await saveSubagentTask(task);
    const retrieved = await getSubagentTask(task.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(task.id);
    expect(retrieved!.description).toBe('Test task');
  });

  test('getSubagentTask returns null for unknown id', async () => {
    const result = await getSubagentTask('nonexistent-id-xyz');
    expect(result).toBeNull();
  });

  test('getSubagentTasksByParent returns all children', async () => {
    const parent = 'parent-3';
    const t1 = createSubagentTask({ parentId: parent, owner: 'u', description: 'Task 1', model: 'gemini-2.5-flash' });
    const t2 = createSubagentTask({ parentId: parent, owner: 'u', description: 'Task 2', model: 'gemma-4-31b-it' });
    await saveSubagentTask(t1);
    await saveSubagentTask(t2);
    const children = await getSubagentTasksByParent(parent);
    const ids = children.map((c) => c.id);
    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);
  });

  test('updateSubagentStatus sets status and timestamps', async () => {
    const task = createSubagentTask({ parentId: 'p4', owner: 'u', description: 'Update me', model: 'gemini-2.5-flash' });
    await saveSubagentTask(task);
    await updateSubagentStatus(task.id, 'RUNNING');
    const updated = await getSubagentTask(task.id);
    expect(updated!.status).toBe('RUNNING');
    expect(updated!.completedAt).toBeNull();
  });

  test('updateSubagentStatus to COMPLETED sets completedAt', async () => {
    const task = createSubagentTask({ parentId: 'p5', owner: 'u', description: 'Complete me', model: 'gemini-2.5-flash' });
    await saveSubagentTask(task);
    await updateSubagentStatus(task.id, 'COMPLETED', ['result.ts']);
    const updated = await getSubagentTask(task.id);
    expect(updated!.status).toBe('COMPLETED');
    expect(updated!.completedAt).not.toBeNull();
    expect(updated!.artifacts).toContain('result.ts');
  });

  test('updateSubagentStatus to FAILED sets completedAt', async () => {
    const task = createSubagentTask({ parentId: 'p6', owner: 'u', description: 'Fail me', model: 'gemini-2.5-flash' });
    await saveSubagentTask(task);
    await updateSubagentStatus(task.id, 'FAILED');
    const updated = await getSubagentTask(task.id);
    expect(updated!.status).toBe('FAILED');
    expect(updated!.completedAt).not.toBeNull();
  });

  test('deleteSubagentTask removes task from store', async () => {
    const task = createSubagentTask({ parentId: 'p7', owner: 'u', description: 'Delete me', model: 'gemini-2.5-flash' });
    await saveSubagentTask(task);
    await deleteSubagentTask(task.id);
    const retrieved = await getSubagentTask(task.id);
    expect(retrieved).toBeNull();
  });

  test('subagent tasks survive independently (no cross-contamination)', async () => {
    const a = createSubagentTask({ parentId: 'parentA', owner: 'u', description: 'A', model: 'gemini-2.5-flash' });
    const b = createSubagentTask({ parentId: 'parentB', owner: 'u', description: 'B', model: 'gemini-2.5-flash' });
    await saveSubagentTask(a);
    await saveSubagentTask(b);
    const childrenA = await getSubagentTasksByParent('parentA');
    const childrenB = await getSubagentTasksByParent('parentB');
    expect(childrenA.map((t) => t.id)).not.toContain(b.id);
    expect(childrenB.map((t) => t.id)).not.toContain(a.id);
  });
});
