/**
 * tests/subagent-merge.test.ts
 *
 * Unit tests for lib/agent/subagent-merge.ts
 */

import { validateMergeInputs, mergeSubagentOutputs } from '../lib/agent/subagent-merge';
import { createSubagentTask } from '../lib/agent/subagent-memory';
import type { SchedulerResult } from '../lib/agent/subagent-scheduler';
import type { SubagentExecutionResult } from '../lib/agent/subagent-executor';

function mockResult(taskId: string, output: string, success = true): SubagentExecutionResult {
  return {
    taskId,
    model: 'gemini-2.5-flash',
    output,
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 500,
    retries: 0,
    success,
  };
}

function makeSchedulerResult(
  tasks: { id: string; output: string; success?: boolean }[],
  failed: string[] = [],
  skipped: string[] = []
): SchedulerResult {
  const outputs = new Map<string, SubagentExecutionResult>(
    tasks.map((t) => [t.id, mockResult(t.id, t.output, t.success ?? true)])
  );
  const completed = tasks.filter((t) => (t.success ?? true) && !failed.includes(t.id)).map((t) => t.id);
  return {
    outputs,
    completed,
    failed,
    skipped,
    totalLatencyMs: 1000,
  };
}

describe('validateMergeInputs', () => {
  test('valid when all tasks completed', () => {
    const t1 = createSubagentTask({ parentId: 'p', owner: 'u', description: 'plan', model: 'gemma-4-31b-it' });
    const t2 = createSubagentTask({ parentId: 'p', owner: 'u', description: 'code', model: 'gemini-2.5-flash', dependencies: [t1.id] });
    const sr = makeSchedulerResult([{ id: t1.id, output: 'plan output' }, { id: t2.id, output: 'code output' }]);
    const result = validateMergeInputs([t1, t2], sr);
    expect(result.valid).toBe(true);
    expect(result.failedTasks).toHaveLength(0);
    expect(result.missingTasks).toHaveLength(0);
  });

  test('invalid when task failed', () => {
    const t = createSubagentTask({ parentId: 'p', owner: 'u', description: 'plan', model: 'gemma-4-31b-it' });
    const sr = makeSchedulerResult([], [t.id]);
    const result = validateMergeInputs([t], sr);
    expect(result.valid).toBe(false);
    expect(result.failedTasks.length).toBeGreaterThan(0);
  });

  test('invalid when task missing from completed', () => {
    const t = createSubagentTask({ parentId: 'p', owner: 'u', description: 'plan', model: 'gemma-4-31b-it' });
    // sr has no completed tasks
    const sr: SchedulerResult = { outputs: new Map(), completed: [], failed: [], skipped: [], totalLatencyMs: 0 };
    const result = validateMergeInputs([t], sr);
    expect(result.valid).toBe(false);
    expect(result.missingTasks.length).toBeGreaterThan(0);
  });

  test('skipped tasks produce warnings not failures', () => {
    const t = createSubagentTask({ parentId: 'p', owner: 'u', description: 'plan', model: 'gemma-4-31b-it' });
    const sr = makeSchedulerResult([], [], [t.id]);
    const result = validateMergeInputs([t], sr);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('mergeSubagentOutputs', () => {
  test('merges multiple outputs into single string', () => {
    const t1 = createSubagentTask({ parentId: 'p', owner: 'u', description: 'plan', model: 'gemma-4-31b-it' });
    const t2 = createSubagentTask({ parentId: 'p', owner: 'u', description: 'code', model: 'gemini-2.5-flash', dependencies: [t1.id] });
    const sr = makeSchedulerResult([
      { id: t1.id, output: 'Step 1: create schema' },
      { id: t2.id, output: 'function createSchema() {}' },
    ]);
    const result = mergeSubagentOutputs([t1, t2], sr);
    expect(result.output).toContain('Step 1: create schema');
    expect(result.output).toContain('function createSchema() {}');
    expect(result.sourceTaskIds).toContain(t1.id);
    expect(result.sourceTaskIds).toContain(t2.id);
  });

  test('deduplicates identical content', () => {
    const t1 = createSubagentTask({ parentId: 'p', owner: 'u', description: 'plan', model: 'gemma-4-31b-it' });
    const t2 = createSubagentTask({ parentId: 'p', owner: 'u', description: 'code', model: 'gemini-2.5-flash', dependencies: [t1.id] });
    const sharedOutput = 'const x = 1;';
    const sr = makeSchedulerResult([
      { id: t1.id, output: sharedOutput },
      { id: t2.id, output: sharedOutput },
    ]);
    const result = mergeSubagentOutputs([t1, t2], sr);
    // Deduplicated: content appears only once
    const occurrences = (result.output.match(new RegExp(sharedOutput, 'g')) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test('sums token counts', () => {
    const t1 = createSubagentTask({ parentId: 'p', owner: 'u', description: 'plan', model: 'gemma-4-31b-it' });
    const t2 = createSubagentTask({ parentId: 'p', owner: 'u', description: 'code', model: 'gemini-2.5-flash', dependencies: [t1.id] });
    const sr = makeSchedulerResult([
      { id: t1.id, output: 'plan' },
      { id: t2.id, output: 'code' },
    ]);
    const result = mergeSubagentOutputs([t1, t2], sr);
    expect(result.totalInputTokens).toBe(200);
    expect(result.totalOutputTokens).toBe(100);
  });

  test('returns placeholder when no outputs available', () => {
    const t = createSubagentTask({ parentId: 'p', owner: 'u', description: 'plan', model: 'gemma-4-31b-it' });
    const sr: SchedulerResult = { outputs: new Map(), completed: [], failed: [t.id], skipped: [], totalLatencyMs: 0 };
    const result = mergeSubagentOutputs([t], sr);
    expect(result.output).toContain('[No subagent outputs available]');
  });
});
