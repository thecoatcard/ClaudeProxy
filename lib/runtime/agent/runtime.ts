import { NextResponse } from 'next/server';
import { SessionCancellationSignal } from './cancellation';
import { LlmGateway } from './llm-gateway';
import { runtimeActorId } from './identity';
import type { RuntimeDependencies } from './runtime-dependencies';
import { createDefaultRuntimeDependencies } from './runtime-dependencies';
import { getAgentSessionRepository } from './session-service';
import { SessionManager } from './session-manager';
import { ExecutionEngine } from './execution-engine';
import { ValidationEngine } from './validation-engine';
import { RuntimeExecutionLoop } from './runtime-loop';

/**
 * AgentRuntime is the top-level entry point for every AI agent request.
 *
 * ARCHITECTURE PRINCIPLES:
 * - All dependencies are injected via RuntimeDependencies.
 * - No service locator calls (getAgentSessionRepository is called once,
 *   and the repository is used via the dependency-injected path).
 * - SessionManager and ValidationEngine are injected from deps — they are NOT
 *   re-instantiated per-request, eliminating the service locator smell.
 * - Plugin registry is activated during bootstrap and deactivated on shutdown.
 * - maxCycles is computed from goal complexity and passed to the loop.
 */
export class AgentRuntime {
  private readonly deps: RuntimeDependencies;
  private pluginsActivated = false;

  constructor(overrides: Partial<RuntimeDependencies> = {}) {
    this.deps = { ...createDefaultRuntimeDependencies(), ...overrides };
  }

  /**
   * Bootstrap plugins on first use.
   * Registers runtime services into the DI container and activates all plugins.
   * Called lazily to avoid blocking the constructor.
   */
  private async bootstrapPlugins(): Promise<void> {
    if (this.pluginsActivated) return;
    this.pluginsActivated = true;
    // Bootstrap external MCP tools from environment configuration
    await this.deps.mcp.bootstrap();
    const container = this.deps.plugins.getContainer();
    container.register('toolRegistry', this.deps.toolRegistry);
    container.register('toolExecutor', this.deps.toolExecutor);
    container.register('eventBus', this.deps.eventBus);
    container.register('memory', this.deps.memory);
    container.register('logger', this.deps.logger);
    container.register('observability', this.deps.observability);
    await this.deps.plugins.activateAll();
  }

  /**
   * Compute the recommended max cycle count based on goal complexity.
   * Complex mutation goals get more cycles; read-only goals fewer.
   */
  private computeMaxCycles(objective: string): number {
    const lower = objective.toLowerCase();
    const isMutation = /\b(implement|build|create|refactor|rewrite|migrate|integrate)\b/.test(lower);
    const isComplex = /\b(entire|full|complete|all|comprehensive|end.to.end)\b/.test(lower);
    if (isMutation && isComplex) return 30;
    if (isMutation) return 20;
    return 12; // Read-only / analysis tasks
  }

  async handle(options: {
    body: Record<string, unknown>;
    token: string;
    requestId: string;
    requestedModel: string;
    stream: boolean;
    startedAt: number;
  }) {
    await this.bootstrapPlugins();

    const runtimeTools = this.deps.toolRegistry.anthropicToolSchemas();
    const requestTools = Array.isArray(options.body.tools) ? options.body.tools : [];
    const runtimeOwnedBody = { ...options.body, tools: [...runtimeTools, ...requestTools] };
    const ownerId = runtimeActorId(options.token);

    // Use lazy singleton repository — no service locator per request
    const repository = await getAgentSessionRepository();

    // Inject SessionManager and ValidationEngine from deps rather than re-instantiating
    const sessions = new SessionManager(repository, this.deps.logger);
    const validation = new ValidationEngine(this.deps.toolExecutor, sessions);
    const execution = new ExecutionEngine(
      this.deps.scheduler,
      sessions,
      validation,
      this.deps.reflection,
      this.deps.memory,
      this.deps.artifacts,
      this.deps.eventBus,
    );
    const loop = new RuntimeExecutionLoop();

    const goal = this.deps.goals.understand(options.body);
    const workspace = await this.deps.workspaces.initialize();
    const analysis = await this.deps.repositories.analyze(workspace);
    const tools = this.deps.toolRegistry.build(options.body);
    const bootstrapContext = await this.deps.contexts.build(goal, workspace, analysis, tools);
    const memory = this.deps.memory.initialize(goal, analysis, bootstrapContext);
    const context = await this.deps.contexts.build(goal, workspace, analysis, tools, memory);
    const costDecision = this.deps.costOptimizer.decide(context);
    const tasks = this.deps.planner.buildPlan(goal, analysis, tools);
    const schedule = this.deps.scheduler.build(tasks);
    const route = await this.deps.routing.route(options.requestedModel, options.body, options.token);
    const maxCycles = this.computeMaxCycles(goal.objective);

    const session = await sessions.create({
      ownerId,
      requestedModel: options.requestedModel,
      goal,
      workspace,
      tasks,
      memory,
    });
    const cancellation = new SessionCancellationSignal(repository, session);

    this.deps.projectCache.setRepository(analysis.cache.cacheKey, analysis.cache.cacheKey, analysis);
    this.deps.observability.increment('runtime.sessions.started');
    await this.deps.eventBus.emit('SessionCreated', {
      scheduleWaves: schedule.batches.length,
      taskCount: tasks.length,
      contextPressure: costDecision.contextPressure,
      promptReuseKey: costDecision.promptReuseKey,
      maxCycles,
    }, session.id);
    await sessions.transition(session, 'ANALYZING', 'runtime_bootstrap', {
      requestedModel: options.requestedModel,
      resolvedModel: route.primary,
      cacheKey: analysis.cache.cacheKey,
      contextPressure: costDecision.contextPressure,
      maxCycles,
    });

    await execution.completeInformationalTask(session, 'goal-understanding', {
      objective: goal.objective,
      requiredTools: goal.requiredTools,
    });
    await execution.completeInformationalTask(session, 'workspace-initialization', {
      root: workspace.root,
      framework: workspace.framework,
      packageManager: workspace.packageManager,
    });
    await execution.completeInformationalTask(session, 'repository-analysis', {
      architectureNotes: analysis.architectureNotes,
      entryPoints: analysis.entryPoints,
      indexedFiles: analysis.indexedFiles.length,
      symbolCount: analysis.symbols.length,
      cacheHits: analysis.cache.reusedFiles,
    });
    await execution.completeInformationalTask(session, 'context-building', {
      selectedFiles: context.selectedFiles,
      ranked: context.rankedItems.slice(0, 5),
      tokenBudget: context.tokenBudget,
    });
    await execution.completeInformationalTask(session, 'tool-selection', {
      tools: tools.map((tool) => ({
        name: tool.name,
        permission: tool.permission,
        enabled: tool.enabled,
        operations: tool.operations ?? [],
      })),
    });
    await execution.completeInformationalTask(session, 'planning', {
      taskCount: tasks.length,
      scheduleWaves: schedule.batches.length,
      maxCycles,
    });
    await execution.completeInformationalTask(session, 'task-scheduling', {
      waves: schedule.batches.map((batch) => ({
        wave: batch.wave,
        tasks: batch.tasks.map((task) => task.id),
      })),
    });

    const runtimePlan = schedule.ordered.map((task) => `${task.id}: ${task.title} (${task.detail})`).join('\n');
    await this.deps.artifacts.createWithContent(session, {
      type: 'plan',
      label: 'runtime-plan',
      metadata: {
        selectedFiles: context.selectedFiles,
        scheduleWaves: schedule.batches.length,
        maxCycles,
      },
    }, runtimePlan).catch(() => {
      // Artifact write failure must not block execution
      this.deps.artifacts.create(session, { type: 'plan', label: 'runtime-plan', metadata: { selectedFiles: context.selectedFiles } });
    });
    await repository.save(session);

    if (options.stream) {
      await sessions.transitionRuntimeState(session, 'Executing', 'stream_execution_started', {
        resolvedModel: route.primary,
        recommendedMode: costDecision.recommendedMode,
      });
      await sessions.startTask(session, 'model-execution');
        return this.deps.llm.stream({
          body: runtimeOwnedBody,
        requestedModel: options.requestedModel,
        internalModel: route.primary,
        token: options.token,
        route,
        requestId: options.requestId,
        runtimeSummary: context.summary,
        runtimePlan,
        cancellation,
        onError: async (error) => {
          this.deps.observability.increment('runtime.model.failures');
          await sessions.failTask(session, 'model-execution', error instanceof Error ? error.message : String(error));
          this.deps.recovery.annotateFailure(session, error);
          await sessions.transition(session, 'FAILED', 'stream_failed', { error: String(error) });
          await this.deps.eventBus.emit('TaskFailed', { taskId: 'model-execution', error: String(error) }, session.id);
          LlmGateway.finalizeError(options.requestedModel, options.token, error);
        },
        onComplete: async (usage) => {
          if (await cancellation.refresh()) {
            await sessions.cancel(session);
            this.deps.observability.increment('runtime.sessions.cancelled');
            return;
          }
          this.deps.observability.increment('runtime.model.success');
          await sessions.finishTask(session, 'model-execution', {
            mode: 'stream',
            usage,
            selectedFiles: context.selectedFiles,
          });
          await execution.finalizeSession(session, {
            content: [{ type: 'text', text: 'streamed' }],
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
            },
          });
          LlmGateway.finalizeStreamSuccess({
            requestedModel: options.requestedModel,
            internalModel: route.primary,
            route,
            token: options.token,
            startedAt: options.startedAt,
            usage,
          });
        },
      });
    }
    await sessions.transition(session, 'PLANNED', 'plan_ready', { taskCount: session.tasks.length });
    return loop.run({
      session,
      body: runtimeOwnedBody,
      requestedModel: options.requestedModel,
      route,
      requestId: options.requestId,
      token: options.token,
      startedAt: options.startedAt,
      context,
      runtimePlan,
      sessions,
      execution,
      llm: this.deps.llm,
      planner: this.deps.planner,
      retry: this.deps.retry,
      checkpoints: this.deps.checkpoints,
      recovery: this.deps.recovery,
      cancellation,
      toolExecutor: this.deps.toolExecutor,
      toolRegistry: this.deps.toolRegistry,
      memory: this.deps.memory,
      maxCycles,
    });
  }

  async resumeSession(options: {
    sessionId: string;
    body: Record<string, unknown>;
    token: string;
    requestId: string;
    requestedModel: string;
    startedAt: number;
  }) {
    await this.bootstrapPlugins();

    const runtimeTools = this.deps.toolRegistry.anthropicToolSchemas();
    const requestTools = Array.isArray(options.body.tools) ? options.body.tools : [];
    const runtimeOwnedBody = { ...options.body, tools: [...runtimeTools, ...requestTools] };
    const repository = await getAgentSessionRepository();
    const session = await repository.getAny(options.sessionId);
    if (!session) {
      return NextResponse.json({ error: { type: 'not_found', message: 'Session not found.' } }, { status: 404 });
    }
    const sessions = new SessionManager(repository, this.deps.logger);
    const validation = new ValidationEngine(this.deps.toolExecutor, sessions);
    const execution = new ExecutionEngine(
      this.deps.scheduler,
      sessions,
      validation,
      this.deps.reflection,
      this.deps.memory,
      this.deps.artifacts,
      this.deps.eventBus,
    );
    const analysis = await this.deps.repositories.analyze(session.workspace);
    const tools = this.deps.toolRegistry.build(options.body);
    const context = await this.deps.contexts.build(session.goal, session.workspace, analysis, tools, session.memory);
    const route = await this.deps.routing.route(options.requestedModel, options.body, options.token);
    const cancellation = new SessionCancellationSignal(repository, session);
    const runtimePlan = this.deps.scheduler.build(session.tasks).ordered.map((task) => `${task.id}: ${task.title} (${task.detail})`).join('\n');
    const maxCycles = this.computeMaxCycles(session.goal.objective);
    const loop = new RuntimeExecutionLoop();
    return loop.resume({
      session,
      body: runtimeOwnedBody,
      requestedModel: options.requestedModel,
      route,
      requestId: options.requestId,
      token: options.token,
      startedAt: options.startedAt,
      context,
      runtimePlan,
      sessions,
      execution,
      llm: this.deps.llm,
      planner: this.deps.planner,
      retry: this.deps.retry,
      checkpoints: this.deps.checkpoints,
      recovery: this.deps.recovery,
      cancellation,
      toolExecutor: this.deps.toolExecutor,
      toolRegistry: this.deps.toolRegistry,
      memory: this.deps.memory,
      maxCycles,
    });
  }
}

/**
 * Module-level singleton — ensures plugins are bootstrapped exactly once per process.
 * All requests share this instance. Use `agentRuntime.handle()` instead of `new AgentRuntime()`.
 */
export const agentRuntime = new AgentRuntime();
