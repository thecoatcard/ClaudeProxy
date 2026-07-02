import { Planner } from '@/lib/runtime/agent/planner';
import { TaskGraphEngine } from '@/lib/runtime/agent/task-graph';

describe('agent runtime planner', () => {
  it('creates a DAG with runtime-owned orchestration stages', () => {
    const planner = new Planner();
    const tasks = planner.buildPlan(
      {
        objective: 'Refactor the runtime architecture',
        missingInformation: [],
        requiredTools: ['filesystem', 'shell'],
        expectedOutputs: ['code changes'],
        constraints: ['plan before model execution'],
      },
      {
        packageManager: 'npm',
        projectType: 'nextjs-api-gateway',
        language: 'typescript',
        framework: 'nextjs',
        architectureNotes: ['Uses Next.js app router structure.'],
        dependencyFiles: ['package.json'],
        buildSystem: ['build', 'test'],
        tests: ['tests/'],
        docker: [],
        ci: [],
        entryPoints: ['app/api/v1/messages/route.ts'],
        candidateContextFiles: ['package.json'],
        indexedFiles: [],
        symbols: [],
        graphs: {
          dependencyGraph: {},
          importGraph: {},
          callGraph: {},
          reverseDependencies: {},
        },
        projectStructure: {},
        repositorySummary: ['Indexed 0 files'],
        cache: {
          cacheKey: 'cache',
          createdAt: 1,
          indexedAt: 1,
          fileCount: 0,
          reusedFiles: 0,
        },
      },
      [{ name: 'filesystem', source: 'runtime', permission: 'safe', enabled: true }],
    );

    const graph = new TaskGraphEngine();
    expect(() => graph.validate(tasks)).not.toThrow();
    expect(tasks.map((task) => task.kind)).toEqual([
      'goal_understanding',
      'workspace_initialization',
      'repository_analysis',
      'context_building',
      'tool_selection',
      'planning',
      'task_scheduling',
      'model_execution',
      'validation',
      'reflection',
      'memory_update',
      'completion',
    ]);
  });
});
