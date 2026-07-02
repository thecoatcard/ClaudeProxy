import type { AgentTaskNode, SchedulerBatch, TaskSchedulerResult } from './contracts';
import { TaskGraphEngine } from './task-graph';

export class TaskScheduler {
  constructor(private readonly graph: TaskGraphEngine) {}

  build(tasks: AgentTaskNode[]): TaskSchedulerResult {
    const ordered = this.graph.topologicalOrder(tasks);
    const depthMemo = new Map<string, number>();
    const byId = new Map(ordered.map((task) => [task.id, task]));

    const depthOf = (task: AgentTaskNode): number => {
      const cached = depthMemo.get(task.id);
      if (cached !== undefined) return cached;
      const depth = task.dependencies.length === 0
        ? 0
        : Math.max(...task.dependencies.map((dependency) => depthOf(byId.get(dependency)!))) + 1;
      depthMemo.set(task.id, depth);
      return depth;
    };

    const grouped = new Map<number, AgentTaskNode[]>();
    for (const task of ordered) {
      const wave = depthOf(task);
      const bucket = grouped.get(wave) ?? [];
      bucket.push(task);
      grouped.set(wave, bucket);
    }

    const batches: SchedulerBatch[] = Array.from(grouped.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([wave, waveTasks]) => ({
        wave,
        tasks: [...waveTasks].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0)),
      }));

    return { ordered, batches };
  }
}
