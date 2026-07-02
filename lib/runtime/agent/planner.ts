import type { AgentGoal, AgentTaskNode, RepositoryInsights, ToolCapability } from './contracts';

function createsWorkspaceMutation(goal: AgentGoal) {
  return /\bfix|implement|refactor|edit|write|create|replace|remove|rename\b/i.test(goal.objective);
}

function needsShell(tools: ToolCapability[]) {
  return tools.some((tool) => tool.name === 'shell' && tool.enabled);
}

export class Planner {
  buildPlan(goal: AgentGoal, analysis: RepositoryInsights, tools: ToolCapability[]): AgentTaskNode[] {
    const mutatesWorkspace = createsWorkspaceMutation(goal);
    const hasTests = analysis.tests.length > 0;
    const shellAvailable = needsShell(tools);

    return [
      {
        id: 'goal-understanding',
        kind: 'goal_understanding',
        title: 'Understand goal',
        detail: `Convert the user request into a structured execution goal for: ${goal.objective}`,
        dependencies: [],
        status: 'PENDING',
        priority: 100,
        executionMode: 'sequential',
        maxAttempts: 1,
      },
      {
        id: 'workspace-initialization',
        kind: 'workspace_initialization',
        title: 'Initialize workspace',
        detail: `Load repository metadata, configuration files, and entry points for ${analysis.projectType}.`,
        dependencies: ['goal-understanding'],
        status: 'PENDING',
        priority: 95,
        executionMode: 'sequential',
      },
      {
        id: 'repository-analysis',
        kind: 'repository_analysis',
        title: 'Analyze repository',
        detail: `Index ${analysis.cache.fileCount} files, ${analysis.symbols.length} symbols, and runtime entry points.`,
        dependencies: ['workspace-initialization'],
        status: 'PENDING',
        priority: 90,
        executionMode: 'sequential',
      },
      {
        id: 'context-building',
        kind: 'context_building',
        title: 'Build context',
        detail: 'Construct a ranked, token-budgeted execution context from repository and memory signals.',
        dependencies: ['repository-analysis'],
        status: 'PENDING',
        priority: 85,
        executionMode: 'parallel',
      },
      {
        id: 'tool-selection',
        kind: 'tool_selection',
        title: 'Select tools',
        detail: `Expose runtime-managed capabilities: ${tools.map((tool) => tool.name).join(', ') || 'none'}.`,
        dependencies: ['repository-analysis'],
        status: 'PENDING',
        priority: 85,
        executionMode: 'parallel',
      },
      {
        id: 'planning',
        kind: 'planning',
        title: 'Plan execution',
        detail: mutatesWorkspace
          ? 'Prepare a mutation-capable execution plan with validation and recovery.'
          : 'Prepare a read-only execution plan and final response path.',
        dependencies: ['context-building', 'tool-selection'],
        status: 'PENDING',
        priority: 82,
        executionMode: 'sequential',
      },
      {
        id: 'task-scheduling',
        kind: 'task_scheduling',
        title: 'Schedule tasks',
        detail: 'Build dependency-aware execution waves for runtime-owned orchestration.',
        dependencies: ['planning'],
        status: 'PENDING',
        priority: 80,
        executionMode: 'sequential',
      },
      {
        id: 'model-execution',
        kind: 'model_execution',
        title: 'Execute model task',
        detail: 'Invoke the model only after planning, context building, and scheduling complete.',
        dependencies: ['task-scheduling'],
        status: 'PENDING',
        priority: 70,
        executionMode: 'sequential',
        checkpointBefore: mutatesWorkspace,
        maxAttempts: 3,
      },
      {
        id: 'validation',
        kind: 'validation',
        title: 'Validate result',
        detail: mutatesWorkspace && shellAvailable && hasTests
          ? 'Run runtime-managed validation for mutated workspace state.'
          : mutatesWorkspace
            ? 'Validate mutated workspace state with available non-shell checks.'
            : 'Skip heavy validation for read-only execution.',
        dependencies: ['model-execution'],
        status: 'PENDING',
        priority: 65,
        executionMode: 'sequential',
      },
      {
        id: 'reflection',
        kind: 'reflection',
        title: 'Reflect on result',
        detail: 'Assess execution output and validation outcome for follow-up or completion.',
        dependencies: ['validation'],
        status: 'PENDING',
        priority: 60,
        executionMode: 'sequential',
      },
      {
        id: 'memory-update',
        kind: 'memory_update',
        title: 'Update memory',
        detail: 'Persist the most important execution outcomes back into runtime memory.',
        dependencies: ['reflection'],
        status: 'PENDING',
        priority: 55,
        executionMode: 'sequential',
      },
      {
        id: 'completion',
        kind: 'completion',
        title: 'Finalize session',
        detail: 'Finalize artifacts, logs, and completion state only after reflection and memory update.',
        dependencies: ['memory-update'],
        status: 'PENDING',
        priority: 50,
        executionMode: 'sequential',
      },
    ];
  }

  replanAfterFailure(tasks: AgentTaskNode[], failedTaskId: string, reason: string) {
    return tasks.map((task) => {
      if (task.id !== failedTaskId) return task;
      return {
        ...task,
        detail: `${task.detail} Replanned after failure: ${reason}`,
        maxAttempts: Math.max(task.maxAttempts ?? 1, (task.attempts ?? 0) + 1),
      };
    });
  }
}
