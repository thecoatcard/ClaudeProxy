/**
 * lib/agent/subagent-scheduler.ts
 *
 * Dependency-aware execution scheduler for subagent tasks.
 *
 * Rules:
 *   - Tasks with no dependencies execute in parallel immediately.
 *   - Tasks with dependencies wait until ALL deps are COMPLETED.
 *   - Concurrency is capped at MAX_PARALLEL (default 4).
 *   - If a required dependency FAILED, the dependent task is skipped.
 */

import { type SubagentTask } from './subagent-memory';
import { executeSubagent, type SubagentExecutionResult } from './subagent-executor';
import { rankModelsByPerformance } from './subagent-performance';

const MAX_PARALLEL = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchedulerResult {
  outputs: Map<string, SubagentExecutionResult>;
  completed: string[];
  failed: string[];
  skipped: string[];
  totalLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Execute all tasks in dependency order.
 * Returns a map of taskId → execution result once all tasks settle.
 */
export async function scheduleSubagentTasks(
  tasks: SubagentTask[]
): Promise<SchedulerResult> {
  const startTime = Date.now();
  const outputs = new Map<string, SubagentExecutionResult>();
  const taskMap = new Map<string, SubagentTask>(tasks.map((t) => [t.id, t]));

  // Phase 8: re-order models by performance before scheduling
  const uniqueModels = [...new Set(tasks.map((t) => t.model))];
  const roleForModel: Record<string, string> = {};
  for (const task of tasks) roleForModel[task.model] = task.description;

  const completed = new Set<string>();
  const failed = new Set<string>();
  const skipped = new Set<string>();
  const inProgress = new Set<string>();

  // Build a mutable "remaining" set
  const remaining = new Set<string>(tasks.map((t) => t.id));

  while (remaining.size > 0 || inProgress.size > 0) {
    // Find ready tasks (deps satisfied, not in-progress)
    const ready: SubagentTask[] = [];
    for (const id of remaining) {
      const task = taskMap.get(id)!;
      const allDepsComplete = task.dependencies.every((dep) => completed.has(dep));
      const anyDepFailed = task.dependencies.some((dep) => failed.has(dep));

      if (anyDepFailed) {
        skipped.add(id);
        remaining.delete(id);
        console.warn(`[Scheduler] Skipping task ${id} — dependency failed`);
        continue;
      }

      if (allDepsComplete && !inProgress.has(id)) {
        ready.push(task);
      }
    }

    if (ready.length === 0 && inProgress.size === 0 && remaining.size > 0) {
      // Deadlock: remaining tasks have unsatisfied deps (likely all failed/skipped)
      for (const id of remaining) {
        skipped.add(id);
      }
      remaining.clear();
      break;
    }

    // Respect concurrency limit
    const slots = MAX_PARALLEL - inProgress.size;
    const batch = ready.slice(0, slots);

    if (batch.length === 0) {
      // Wait for at least one in-progress task to finish
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }

    // Remove batch from remaining and mark in-progress
    for (const task of batch) {
      remaining.delete(task.id);
      inProgress.add(task.id);
    }

    // Build dependency output context for each batch task
    const executions = batch.map(async (task) => {
      const depOutputs = new Map<string, string>();
      for (const depId of task.dependencies) {
        const depResult = outputs.get(depId);
        if (depResult?.success) depOutputs.set(depId, depResult.output);
      }

      console.info(
        `[Scheduler] Starting task=${task.id} model=${task.model} deps=${task.dependencies.length}`
      );

      const result = await executeSubagent(task, depOutputs);
      outputs.set(task.id, result);
      inProgress.delete(task.id);

      if (result.success) {
        completed.add(task.id);
        console.info(
          `[Scheduler] Completed task=${task.id} model=${result.model} latency=${result.latencyMs}ms`
        );
      } else {
        failed.add(task.id);
        console.warn(`[Scheduler] Failed task=${task.id} error=${result.error}`);
      }
    });

    // Don't await all — let some run while we re-check the loop
    // We await the batch so the outer loop can re-evaluate ready tasks
    await Promise.all(executions);
  }

  return {
    outputs,
    completed: [...completed],
    failed: [...failed],
    skipped: [...skipped],
    totalLatencyMs: Date.now() - startTime,
  };
}
