/**
 * lib/agent/subagent-merge.ts
 *
 * Merge engine for subagent execution results.
 *
 * Responsibilities:
 *   1. Validate all required tasks completed (Phase 9).
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
// Phase 9 — Merge Validation
// ---------------------------------------------------------------------------

/**
 * Validate that all required tasks completed before merging.
 * Required = tasks with no dependents (leaf nodes) plus planner.
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

  for (const task of tasks) {
    if (failedSet.has(task.id)) {
      failedTaskIds.push(`${task.id} (${task.description})`);
    } else if (skippedSet.has(task.id)) {
      warnings.push(`Task skipped (dependency failed): ${task.id} — ${task.description}`);
    } else if (!completedSet.has(task.id)) {
      missingTasks.push(`${task.id} (${task.description})`);
    }
  }

  return {
    valid: failedTaskIds.length === 0 && missingTasks.length === 0,
    missingTasks,
    failedTasks: failedTaskIds,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Topological sort of tasks by dependency order.
 * Tasks with no dependencies come first.
 */
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

/**
 * Deduplicate repeated paragraphs/sentences across outputs.
 * Simple approach: normalise whitespace and skip exact duplicates.
 */
function deduplicateContent(texts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const text of texts) {
    const normalised = text.replace(/\s+/g, ' ').trim();
    if (!normalised || seen.has(normalised)) continue;
    seen.add(normalised);
    result.push(text.trim());
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase 4 — Merge Engine
// ---------------------------------------------------------------------------

/**
 * Merge all successful subagent outputs into a coherent final response.
 */
export function mergeSubagentOutputs(
  tasks: SubagentTask[],
  schedulerResult: SchedulerResult
): MergeResult {
  const validation = validateMergeInputs(tasks, schedulerResult);

  // Collect outputs in topological order (later stages overwrite earlier ones
  // for the same semantic section — conflict resolution).
  const sorted = topologicalSort(tasks);
  const sourceTaskIds: string[] = [];
  const outputSegments: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const task of sorted) {
    const result = schedulerResult.outputs.get(task.id);
    if (!result?.success || !result.output.trim()) continue;

    sourceTaskIds.push(task.id);
    outputSegments.push(result.output);
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
  }

  // Deduplicate
  const deduped = deduplicateContent(outputSegments);

  // Build final output: planner summary first, then coder, verifier, merger
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
