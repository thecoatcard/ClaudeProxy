/**
 * lib/agent/subagent-scheduler.ts
 *
 * Dependency-aware execution scheduler for subagent tasks.
 */

import { type SubagentTask, updateSubagentStatus } from './subagent-memory';
import { executeSubagent, type SubagentExecutionResult } from './subagent-executor';

const MAX_PARALLEL = Number(process.env.SUBAGENT_MAX_PARALLEL || 4);

export interface SchedulerResult {
  outputs: Map<string, SubagentExecutionResult>;
  completed: string[];
  failed: string[];
  skipped: string[];
  totalLatencyMs: number;
}

export interface SchedulerOptions {
  preCompletedTaskIds?: string[];
  preResolvedOutputs?: Map<string, SubagentExecutionResult>;
}

export async function scheduleSubagentTasks(
  tasks: SubagentTask[],
  options: SchedulerOptions = {},
): Promise<SchedulerResult> {
  const startTime = Date.now();
  const outputs = new Map<string, SubagentExecutionResult>(options.preResolvedOutputs ?? []);
  const taskMap = new Map<string, SubagentTask>(tasks.map((t) => [t.id, t]));

  const completed = new Set<string>(options.preCompletedTaskIds ?? []);
  const failed = new Set<string>();
  const skipped = new Set<string>();
  const inProgress = new Set<string>();
  const remaining = new Set<string>(tasks.map((t) => t.id));

  while (remaining.size > 0 || inProgress.size > 0) {
    const ready: SubagentTask[] = [];

    for (const id of remaining) {
      const task = taskMap.get(id);
      if (!task) continue;

      const allDepsComplete = task.dependencies.every((dep) => completed.has(dep) || !taskMap.has(dep));
      const anyDepFailed = task.dependencies.some((dep) => failed.has(dep) || skipped.has(dep));

      if (anyDepFailed) {
        skipped.add(id);
        remaining.delete(id);
        await updateSubagentStatus(id, 'SKIPPED').catch(() => {});
        console.warn(`[Scheduler] Skipping task ${id}: dependency failed or skipped`);
        continue;
      }

      if (allDepsComplete && !inProgress.has(id)) {
        ready.push(task);
      }
    }

    if (ready.length === 0 && inProgress.size === 0 && remaining.size > 0) {
      for (const id of remaining) {
        skipped.add(id);
        await updateSubagentStatus(id, 'SKIPPED').catch(() => {});
        console.error(`[Scheduler] Marking task ${id} as skipped: deadlock/unmet dependency chain`);
      }
      remaining.clear();
      break;
    }

    const slots = MAX_PARALLEL - inProgress.size;
    const batch = ready.slice(0, Math.max(0, slots));

    if (batch.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }

    for (const task of batch) {
      remaining.delete(task.id);
      inProgress.add(task.id);
    }

    const executions = batch.map(async (task) => {
      const depOutputs = new Map<string, string>();
      for (const depId of task.dependencies) {
        const depResult = outputs.get(depId);
        if (depResult?.success) depOutputs.set(depId, depResult.output);
      }

      console.info(`[Scheduler] Starting task=${task.id} model=${task.model} deps=${task.dependencies.length}`);

      const result = await executeSubagent(task, depOutputs);
      outputs.set(task.id, result);
      inProgress.delete(task.id);

      if (result.success) {
        completed.add(task.id);
        console.info(`[Scheduler] Completed task=${task.id} model=${result.model} latency=${result.latencyMs}ms`);
      } else {
        failed.add(task.id);
        console.warn(`[Scheduler] Failed task=${task.id} error=${result.error}`);
      }
    });

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
