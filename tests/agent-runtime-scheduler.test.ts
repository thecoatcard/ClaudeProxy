import { TaskGraphEngine } from '@/lib/runtime/agent/task-graph';
import { TaskScheduler } from '@/lib/runtime/agent/task-scheduler';

describe('agent runtime scheduler', () => {
  it('builds execution waves from a DAG', () => {
    const scheduler = new TaskScheduler(new TaskGraphEngine());
    const result = scheduler.build([
      { id: 'a', kind: 'goal_understanding', title: 'a', detail: 'a', dependencies: [], status: 'PENDING', priority: 1 },
      { id: 'b', kind: 'workspace_initialization', title: 'b', detail: 'b', dependencies: ['a'], status: 'PENDING', priority: 5 },
      { id: 'c', kind: 'tool_selection', title: 'c', detail: 'c', dependencies: ['a'], status: 'PENDING', priority: 2 },
      { id: 'd', kind: 'planning', title: 'd', detail: 'd', dependencies: ['b', 'c'], status: 'PENDING', priority: 3 },
    ]);

    expect(result.batches).toHaveLength(3);
    expect(result.batches[0].tasks.map((task) => task.id)).toEqual(['a']);
    expect(result.batches[1].tasks.map((task) => task.id)).toEqual(['b', 'c']);
    expect(result.batches[2].tasks.map((task) => task.id)).toEqual(['d']);
  });
});
