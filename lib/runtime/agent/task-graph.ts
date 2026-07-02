import type { AgentTaskNode, TaskSchedulerResult } from './contracts';

export class TaskGraphEngine {
  validate(tasks: AgentTaskNode[]) {
    const ids = new Set(tasks.map((task) => task.id));
    if (ids.size !== tasks.length) {
      throw new Error('Task graph contains duplicate task ids');
    }

    for (const task of tasks) {
      for (const dependency of task.dependencies) {
        if (!ids.has(dependency)) {
          throw new Error(`Task graph references missing dependency: ${dependency}`);
        }
      }
    }

    this.topologicalOrder(tasks);
  }

  topologicalOrder(tasks: AgentTaskNode[]) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const ordered: AgentTaskNode[] = [];

    const visit = (taskId: string) => {
      if (visited.has(taskId)) return;
      if (visiting.has(taskId)) throw new Error(`Task graph contains a cycle at ${taskId}`);
      visiting.add(taskId);
      const task = byId.get(taskId);
      if (!task) return;
      for (const dependency of task.dependencies) {
        visit(dependency);
      }
      visiting.delete(taskId);
      visited.add(taskId);
      ordered.push(task);
    };

    for (const task of tasks) {
      visit(task.id);
    }

    return ordered;
  }

  schedule(tasks: AgentTaskNode[]): TaskSchedulerResult {
    this.validate(tasks);
    const remaining = new Map(tasks.map((task) => [task.id, { ...task }]));
    const completed = new Set<string>();
    const ordered: AgentTaskNode[] = [];
    const batches: TaskSchedulerResult['batches'] = [];
    let wave = 0;

    while (remaining.size > 0) {
      const ready = Array.from(remaining.values())
        .filter((task) => task.dependencies.every((dependency) => completed.has(dependency)))
        .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));

      if (ready.length === 0) {
        throw new Error('Task graph scheduler is deadlocked');
      }

      const parallel = ready.filter((task) => task.executionMode === 'parallel');
      const sequential = ready.filter((task) => task.executionMode !== 'parallel');
      const batchTasks = parallel.length > 0 ? parallel : sequential.slice(0, 1);
      batches.push({ wave: wave++, tasks: batchTasks });

      for (const task of batchTasks) {
        ordered.push(task);
        completed.add(task.id);
        remaining.delete(task.id);
      }
    }

    return { ordered, batches };
  }

  insertDynamicTask(tasks: AgentTaskNode[], task: AgentTaskNode) {
    this.validate(tasks);
    if (tasks.some((candidate) => candidate.id === task.id)) {
      throw new Error(`Task graph already contains task: ${task.id}`);
    }
    const next = [...tasks, task];
    this.validate(next);
    return next;
  }
}
