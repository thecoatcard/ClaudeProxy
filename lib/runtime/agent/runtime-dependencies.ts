import { ArtifactManager } from './artifact-manager';
import { CheckpointManager } from './checkpoint-manager';
import { ContextBuilder } from './context-builder';
import { RuntimeCostOptimizer } from './cost-optimizer';
import { DistributedExecutionCoordinator } from './distributed-execution';
import { RuntimeEventBus } from './event-bus';
import { GoalUnderstandingService } from './goal-understanding';
import { LlmGateway } from './llm-gateway';
import { RuntimeLoggingEngine } from './logging-engine';
import { MemoryManager } from './memory-manager';
import { McpRuntime } from './mcp-runtime';
import { RuntimeModelRouter } from './model-routing-service';
import { PermissionManager } from './permission-manager';
import { Planner } from './planner';
import { globalProjectCache } from './project-cache';
import { RecoveryManager } from './recovery-manager';
import { RuntimeRetryManager } from './retry-manager';
import { ReflectionEngine } from './reflection-engine';
import { RepositoryAnalyzer } from './repository-analyzer';
import { RuntimePluginRegistry } from './plugin-sdk';
import { globalRuntimeObservability } from './runtime-observability';
import { TaskGraphEngine } from './task-graph';
import { createRuntimeToolAdapters } from './tool-adapters';
import { ToolExecutor } from './tool-executor';
import { TaskScheduler } from './task-scheduler';
import { ToolRegistry } from './tool-registry';
import { ValidationEngine } from './validation-engine';
import { WorkspaceManager } from './workspace-manager';

export interface RuntimeDependencies {
  goals: GoalUnderstandingService;
  workspaces: WorkspaceManager;
  repositories: RepositoryAnalyzer;
  permissions: PermissionManager;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  contexts: ContextBuilder;
  memory: MemoryManager;
  planner: Planner;
  routing: RuntimeModelRouter;
  logger: RuntimeLoggingEngine;
  graph: TaskGraphEngine;
  scheduler: TaskScheduler;
  validation: ValidationEngine;
  reflection: ReflectionEngine;
  llm: LlmGateway;
  checkpoints: CheckpointManager;
  recovery: RecoveryManager;
  retry: RuntimeRetryManager;
  eventBus: RuntimeEventBus;
  artifacts: ArtifactManager;
  costOptimizer: RuntimeCostOptimizer;
  projectCache: typeof globalProjectCache;
  plugins: RuntimePluginRegistry;
  mcp: McpRuntime;
  observability: typeof globalRuntimeObservability;
  distributed: DistributedExecutionCoordinator;
}

export function createDefaultRuntimeDependencies(): RuntimeDependencies {
  const permissions = new PermissionManager();
  const graph = new TaskGraphEngine();
  const mcp = new McpRuntime();
  const eventBus = new RuntimeEventBus();
  const logger = new RuntimeLoggingEngine();
  const observability = globalRuntimeObservability;
  const toolRegistry = new ToolRegistry(permissions, createRuntimeToolAdapters(mcp));
  const toolExecutor = new ToolExecutor(toolRegistry, permissions, eventBus, logger, observability);
  const memory = new MemoryManager();
  return {
    goals: new GoalUnderstandingService(),
    workspaces: new WorkspaceManager(),
    repositories: new RepositoryAnalyzer(),
    permissions,
    toolRegistry,
    toolExecutor,
    contexts: new ContextBuilder(memory),
    memory,
    planner: new Planner(),
    routing: new RuntimeModelRouter(),
    logger,
    graph,
    scheduler: new TaskScheduler(graph),
    validation: new ValidationEngine(toolExecutor),
    reflection: new ReflectionEngine(),
    llm: new LlmGateway(),
    checkpoints: new CheckpointManager(),
    recovery: new RecoveryManager(),
    retry: new RuntimeRetryManager(),
    eventBus,
    artifacts: new ArtifactManager(),
    costOptimizer: new RuntimeCostOptimizer(),
    projectCache: globalProjectCache,
    plugins: new RuntimePluginRegistry(),
    mcp,
    observability,
    distributed: new DistributedExecutionCoordinator(),
  };
}
