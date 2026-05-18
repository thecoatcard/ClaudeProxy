/**
 * lib/agent/subagent-merge.ts
 *
 * Merge engine for subagent execution results.
 *
 * Responsibilities:
 *   1. Validate all required tasks completed.
 *   2. Collect outputs in dependency order.
 *   3. Deduplicate repeated content.
 *   4. Resolve conflicts (later-stage task wins).
 *   5. Build a coherent final merged output.
 */

import { type SubagentTask } from './subagent-memory';
import { type SubagentExecutionResult } from './subagent-executor';
import { type SchedulerResult } from './subagent-scheduler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeValidationResult {
  valid: boolean;
  missingTasks: string[];
  failedTasks: string[];
  warnings: string[];
}

export interface MergeResult {
  output: string;
  validation: MergeValidationResult;
  sourceTaskIds: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that all tasks are complete before merging.
 * Uses both current scheduler outputs and persisted task snapshots.
 */
export function validateMergeInputs(
  tasks: SubagentTask[],
  schedulerResult: SchedulerResult
): MergeValidationResult {
  const { completed, failed, skipped } = schedulerResult;
  const completedSet = new Set(completed);
  const failedSet = new Set(failed);
  const skippedSet = new Set(skipped);

  const missingTasks: string[] = [];
  const failedTaskIds: string[] = [];
  const warnings: string[] = [];
  let hasSkipped = false;

  for (const task of tasks) {
    const persistedSuccess = task.execution?.success === true || task.status === 'COMPLETED';
    const persistedFailure = task.execution?.success === false || task.status === 'FAILED';

    if (failedSet.has(task.id) || persistedFailure) {
      failedTaskIds.push(`${task.id} (${task.description})`);
      continue;
    }

    if (skippedSet.has(task.id)) {
      warnings.push(`Task skipped (dependency failed): ${task.id} - ${task.description}`);
      hasSkipped = true;
      continue;
    }

    if (!completedSet.has(task.id) && !persistedSuccess) {
      missingTasks.push(`${task.id} (${task.description})`);
    }
  }

  return {
    valid: failedTaskIds.length === 0 && missingTasks.length === 0 && !hasSkipped,
    missingTasks,
    failedTasks: failedTaskIds,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function topologicalSort(tasks: SubagentTask[]): SubagentTask[] {
  const taskMap = new Map<string, SubagentTask>(tasks.map((t) => [t.id, t]));
  const sorted: SubagentTask[] = [];
  const visited = new Set<string>();

  function visit(id: string) {
    if (visited.has(id)) return;
    const task = taskMap.get(id);
    if (!task) return;
    for (const dep of task.dependencies) visit(dep);
    visited.add(id);
    sorted.push(task);
  }

  for (const task of tasks) visit(task.id);
  return sorted;
}

function deduplicateContent(texts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const text of texts) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(text.trim());
  }
  return result;
}

function getResultForTask(
  task: SubagentTask,
  schedulerResult: SchedulerResult,
): SubagentExecutionResult | null {
  const runtimeResult = schedulerResult.outputs.get(task.id);
  if (runtimeResult) return runtimeResult;

  const snapshot = task.execution;
  if (!snapshot) return null;

  return {
    taskId: task.id,
    model: snapshot.model,
    output: snapshot.output,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    latencyMs: snapshot.latencyMs,
    retries: snapshot.retries,
    success: snapshot.success,
    error: snapshot.error,
  };
}

// ---------------------------------------------------------------------------
// Merge engine
// ---------------------------------------------------------------------------

export function mergeSubagentOutputs(
  tasks: SubagentTask[],
  schedulerResult: SchedulerResult
): MergeResult {
  const validation = validateMergeInputs(tasks, schedulerResult);

  const sorted = topologicalSort(tasks);
  const sourceTaskIds: string[] = [];
  const outputSegments: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const task of sorted) {
    const result = getResultForTask(task, schedulerResult);
    if (!result?.success || !result.output.trim()) continue;

    sourceTaskIds.push(task.id);
    outputSegments.push(result.output);
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
  }

  const deduped = deduplicateContent(outputSegments);
  const finalOutput = deduped.join('\n\n---\n\n');

  if (validation.warnings.length > 0) {
    console.warn('[MergeEngine] Merge warnings:', validation.warnings.join('; '));
  }

  return {
    output: finalOutput || '[No subagent outputs available]',
    validation,
    sourceTaskIds,
    totalInputTokens,
    totalOutputTokens,
  };
}
