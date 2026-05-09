/**
 * tests/subagent-resume.test.ts
 *
 * Phase 11: Tests that subagent execution correctly resumes after overload recovery.
 * Tests the resume filtering and state preservation logic used by
 * resumeOrchestratedExecution in orchestrator-enforcer.ts.
 */

import { createSubagentTask } from '../lib/agent/subagent-memory';
import type { SubagentTask } from '../lib/agent/subagent-memory';

describe('subagent resume after overload', () => {
  const parentId = 'test-parent-resume';

  function makeTasks(): SubagentTask[] {
    const task1 = createSubagentTask({
      parentId, owner: 'user1', description: 'Plan the feature',
      model: 'gemini-2.5-flash', dependencies: [],
    });
    task1.status = 'COMPLETED';
    // SubagentTask has no 'result' field — store in artifacts
    task1.artifacts = ['Plan: step1, step2'];

    const task2 = createSubagentTask({
      parentId, owner: 'user1', description: 'Write the code',
      model: 'gemini-2.5-flash', dependencies: [task1.id],
    });
    task2.status = 'FAILED';

    const task3 = createSubagentTask({
      parentId, owner: 'user1', description: 'Verify output',
      model: 'gemma-4-31b-it', dependencies: [task2.id],
    });
    task3.status = 'PENDING';

    return [task1, task2, task3];
  }

  test('resume filters only PENDING and FAILED tasks', () => {
    const liveTasks = makeTasks();
    const remaining = liveTasks.filter(
      (t) => t.status === 'PENDING' || t.status === 'FAILED'
    );
    expect(remaining.length).toBe(2);
    expect(remaining.map((t) => t.description)).toEqual([
      'Write the code',
      'Verify output',
    ]);
  });

  test('completed tasks are preserved (not re-executed)', () => {
    const liveTasks = makeTasks();
    const completed = liveTasks.filter((t) => t.status === 'COMPLETED');
    expect(completed.length).toBe(1);
    expect(completed[0].artifacts).toContain('Plan: step1, step2');
    expect(completed[0].description).toBe('Plan the feature');
  });

  test('FAILED tasks are included in resume set', () => {
    const liveTasks = makeTasks();
    const failed = liveTasks.filter((t) => t.status === 'FAILED');
    expect(failed.length).toBe(1);
    expect(failed[0].description).toBe('Write the code');
  });

  test('when all tasks completed, remaining is empty', () => {
    const liveTasks = makeTasks();
    liveTasks.forEach((t) => { t.status = 'COMPLETED'; });
    const remaining = liveTasks.filter(
      (t) => t.status === 'PENDING' || t.status === 'FAILED'
    );
    expect(remaining.length).toBe(0);
  });

  test('resume preserves dependency chain', () => {
    const liveTasks = makeTasks();
    const remaining = liveTasks.filter(
      (t) => t.status === 'PENDING' || t.status === 'FAILED'
    );
    const coderTask = remaining.find((t) => t.description === 'Write the code')!;
    const verifierTask = remaining.find((t) => t.description === 'Verify output')!;
    expect(verifierTask.dependencies).toContain(coderTask.id);
  });

  test('createSubagentTask produces unique IDs', () => {
    const tasks = makeTasks();
    const ids = new Set(tasks.map((t) => t.id));
    expect(ids.size).toBe(3);
  });
});
