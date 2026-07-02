import type { ModelRoute } from '@/lib/model-router';
import { ArtifactManager } from '@/lib/runtime/agent/artifact-manager';
import { CheckpointManager } from '@/lib/runtime/agent/checkpoint-manager';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRepository,
  CreateSessionInput,
  RuntimeMemory,
  WorkspaceContext,
} from '@/lib/runtime/agent/contracts';
import { ExecutionEngine } from '@/lib/runtime/agent/execution-engine';
import { RuntimeEventBus } from '@/lib/runtime/agent/event-bus';
import { RuntimeLoggingEngine } from '@/lib/runtime/agent/logging-engine';
import { MemoryManager } from '@/lib/runtime/agent/memory-manager';
import { Planner } from '@/lib/runtime/agent/planner';
import { RecoveryManager } from '@/lib/runtime/agent/recovery-manager';
import { ReflectionEngine } from '@/lib/runtime/agent/reflection-engine';
import { RuntimeRetryManager } from '@/lib/runtime/agent/retry-manager';
import { RuntimeExecutionLoop } from '@/lib/runtime/agent/runtime-loop';
import { TaskGraphEngine } from '@/lib/runtime/agent/task-graph';
import { TaskScheduler } from '@/lib/runtime/agent/task-scheduler';
import { createRuntimeToolAdapters } from '@/lib/runtime/agent/tool-adapters';
import { PermissionManager } from '@/lib/runtime/agent/permission-manager';
import { ToolExecutor } from '@/lib/runtime/agent/tool-executor';
import { ToolRegistry } from '@/lib/runtime/agent/tool-registry';
import { McpRuntime } from '@/lib/runtime/agent/mcp-runtime';
import { ValidationEngine } from '@/lib/runtime/agent/validation-engine';
import { SessionCancellationSignal } from '@/lib/runtime/agent/cancellation';
import { SessionManager } from '@/lib/runtime/agent/session-manager';
import { LlmGateway } from '@/lib/runtime/agent/llm-gateway';

class InMemorySessionRepository implements AgentSessionRepository {
  sessions = new Map<string, AgentSession>();
  sessionEvents: AgentSessionEvent[] = [];
  async ensureIndexes() {}
  async create(input: CreateSessionInput): Promise<AgentSession> {
    const now = Date.now();
    const session: AgentSession = {
      id: `session-${this.sessions.size + 1}`,
      ownerId: input.ownerId,
      version: 1,
      requestedModel: input.requestedModel,
      goal: input.goal,
      workspace: input.workspace,
      status: 'CREATED',
      currentState: 'session_created',
      tasks: input.tasks,
      completedTasks: [],
      pendingTasks: input.tasks.map((task) => task.id),
      runningTasks: [],
      modifiedFiles: ['src/index.ts'],
      logs: [],
      runtimeState: 'Idle',
      runtimeHistory: [{ at: now, state: 'Idle', detail: 'created' }],
      browserState: {},
      gitState: {},
      memory: input.memory,
      checkpoints: [],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }
  async get(ownerId: string, sessionId: string) { return this.sessions.get(sessionId)?.ownerId === ownerId ? this.sessions.get(sessionId)! : null; }
  async getAny(sessionId: string) { return this.sessions.get(sessionId) ?? null; }
  async list() { return Array.from(this.sessions.values()); }
  async listAll() { return Array.from(this.sessions.values()); }
  async save(session: AgentSession) { session.version += 1; session.updatedAt = Date.now(); this.sessions.set(session.id, session); }
  async requestCancellation(ownerId: string, sessionId: string) { return this.get(ownerId, sessionId); }
  async requestCancellationAny(sessionId: string) { return this.getAny(sessionId); }
  async events(ownerId: string, sessionId: string) { return this.sessionEvents.filter((event) => event.ownerId === ownerId && event.sessionId === sessionId); }
  async eventsAny(sessionId: string) { return this.sessionEvents.filter((event) => event.sessionId === sessionId); }
  async appendEvent(event: Omit<AgentSessionEvent, 'id' | 'createdAt'>) {
    this.sessionEvents.push({ id: `evt-${this.sessionEvents.length + 1}`, createdAt: Date.now(), ...event });
  }
}

function makeWorkspace(): WorkspaceContext {
  return {
    root: process.cwd(),
    packageManager: 'npm',
    projectType: 'nextjs-api-gateway',
    language: 'typescript',
    framework: 'nextjs',
    configFiles: [],
    entryPoints: [],
  };
}

function makeMemory(): RuntimeMemory {
  return {
    sessionNotes: [],
    projectFacts: [],
    semanticFacts: [],
    longTermFacts: [],
    architectureFacts: [],
    conversationFacts: [],
    toolExecutionFacts: [],
    selectedFiles: [],
  };
}

function makeRoute(): ModelRoute {
  return {
    primary: 'gemini-2.5-flash',
    fallback: [],
    routingSource: 'local',
    taskType: 'CHAT',
    taskReason: 'test',
    routeVersion: '1',
  };
}

function makeTooling() {
  const permissions = new PermissionManager({ autoApproveSafe: true, autoApproveConfirmationRequired: false, allowedDangerousOperations: [] });
  const registry = new ToolRegistry(permissions, createRuntimeToolAdapters(new McpRuntime()));
  const executor = new ToolExecutor(
    registry,
    permissions,
    new RuntimeEventBus(),
    new RuntimeLoggingEngine(),
    { increment() {}, recordDuration() {} } as any,
  );
  return { registry, executor };
}

function makeSession(repository: InMemorySessionRepository) {
  const planner = new Planner();
  return repository.create({
    ownerId: 'owner',
    requestedModel: 'claude-test',
    goal: {
      objective: 'Implement runtime loop',
      missingInformation: [],
      requiredTools: [],
      expectedOutputs: ['response'],
      constraints: [],
    },
    workspace: makeWorkspace(),
    tasks: planner.buildPlan(
      {
        objective: 'Implement runtime loop',
        missingInformation: [],
        requiredTools: [],
        expectedOutputs: ['response'],
        constraints: [],
      },
      {
        packageManager: 'npm',
        projectType: 'nextjs-api-gateway',
        language: 'typescript',
        framework: 'nextjs',
        architectureNotes: [],
        dependencyFiles: [],
        buildSystem: [],
        tests: [],
        docker: [],
        ci: [],
        entryPoints: [],
        candidateContextFiles: [],
        indexedFiles: [],
        symbols: [],
        graphs: { dependencyGraph: {}, importGraph: {}, callGraph: {}, reverseDependencies: {} },
        projectStructure: {},
        repositorySummary: [],
        cache: { cacheKey: 'cache', createdAt: Date.now(), indexedAt: Date.now(), fileCount: 0, reusedFiles: 0 },
      },
      [],
    ),
    memory: makeMemory(),
  });
}

describe('runtime execution loop', () => {
  const finalizeSuccessSpy = jest.spyOn(LlmGateway, 'finalizeSuccess').mockImplementation(() => {});
  const finalizeErrorSpy = jest.spyOn(LlmGateway, 'finalizeError').mockImplementation(() => '');

  afterAll(() => {
    finalizeSuccessSpy.mockRestore();
    finalizeErrorSpy.mockRestore();
  });

  it('runs to completion and records runtime history/checkpoints', async () => {
    const repository = new InMemorySessionRepository();
    const session = await makeSession(repository);
    for (const task of session.tasks) {
      if (task.id !== 'model-execution') {
        task.status = 'COMPLETED';
      }
    }
    const sessions = new SessionManager(repository, new RuntimeLoggingEngine());
    const execution = new ExecutionEngine(
      new TaskScheduler(new TaskGraphEngine()),
      sessions,
      new ValidationEngine(),
      new ReflectionEngine(),
      new MemoryManager(),
      new ArtifactManager(),
      new RuntimeEventBus(),
    );
    const tooling = makeTooling();
    const llm = { execute: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Successfully completed the implementation plan with all required changes.' }], usage: { input_tokens: 1, output_tokens: 1 } }) } as unknown as LlmGateway;
    const loop = new RuntimeExecutionLoop();

    const response = await loop.run({
      session,
      body: { messages: [] },
      requestedModel: 'claude-test',
      route: makeRoute(),
      requestId: 'req-1',
      token: 'token',
      startedAt: Date.now(),
      context: { summary: 'summary', selectedFiles: [], rankedItems: [], repositoryFacts: [], toolSummary: [], memorySummary: [], tokenBudget: 2000 },
      runtimePlan: 'plan',
      sessions,
      execution,
      llm,
      planner: new Planner(),
      retry: new RuntimeRetryManager(),
      checkpoints: new CheckpointManager(),
      recovery: new RecoveryManager(),
      cancellation: new SessionCancellationSignal(repository, session),
      toolExecutor: tooling.executor,
      toolRegistry: tooling.registry,
      memory: new MemoryManager(),
    });

    expect(response.status).toBe(200);
    expect(session.runtimeState).toBe('Completed');
    expect(session.runtimeHistory.map((entry) => entry.state)).toEqual(
      expect.arrayContaining(['Initializing', 'Planning', 'Executing', 'Reflecting', 'Completed']),
    );
    expect(session.checkpoints.length).toBeGreaterThan(0);
  });

  it('retries, replans, and completes after a transient model failure', async () => {
    const repository = new InMemorySessionRepository();
    const session = await makeSession(repository);
    const sessions = new SessionManager(repository, new RuntimeLoggingEngine());
    const execution = new ExecutionEngine(
      new TaskScheduler(new TaskGraphEngine()),
      sessions,
      new ValidationEngine(),
      new ReflectionEngine(),
      new MemoryManager(),
      new ArtifactManager(),
      new RuntimeEventBus(),
    );
    const tooling = makeTooling();
    const llm = {
      execute: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } }),
    } as unknown as LlmGateway;

    const loop = new RuntimeExecutionLoop();
    const response = await loop.run({
      session,
      body: { messages: [] },
      requestedModel: 'claude-test',
      route: makeRoute(),
      requestId: 'req-2',
      token: 'token',
      startedAt: Date.now(),
      context: { summary: 'summary', selectedFiles: [], rankedItems: [], repositoryFacts: [], toolSummary: [], memorySummary: [], tokenBudget: 2000 },
      runtimePlan: 'plan',
      sessions,
      execution,
      llm,
      planner: new Planner(),
      retry: new RuntimeRetryManager(),
      checkpoints: new CheckpointManager(),
      recovery: new RecoveryManager(),
      cancellation: new SessionCancellationSignal(repository, session),
      toolExecutor: tooling.executor,
      toolRegistry: tooling.registry,
      memory: new MemoryManager(),
    });

    expect(response.status).toBe(200);
    expect(session.runtimeHistory.some((entry) => entry.state === 'Retrying')).toBe(true);
    expect(session.tasks.find((task) => task.id === 'model-execution')?.detail).toContain('Replanned after failure');
  });

  it('restores from the latest checkpoint on resume', async () => {
    const repository = new InMemorySessionRepository();
    const session = await makeSession(repository);
    for (const task of session.tasks) {
      if (task.id !== 'model-execution') {
        task.status = 'COMPLETED';
      }
    }
    const sessions = new SessionManager(repository, new RuntimeLoggingEngine());
    const checkpoints = new CheckpointManager();
    const recovery = new RecoveryManager(checkpoints);
    const execution = new ExecutionEngine(
      new TaskScheduler(new TaskGraphEngine()),
      sessions,
      new ValidationEngine(),
      new ReflectionEngine(),
      new MemoryManager(),
      new ArtifactManager(),
      new RuntimeEventBus(),
    );
    await sessions.transitionRuntimeState(session, 'Initializing', 'boot');
    await sessions.appendCheckpoint(session, checkpoints.create(session, 'boot'));
    await sessions.transitionRuntimeState(session, 'Failed', 'crash');
    const tooling = makeTooling();

    const llm = { execute: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Successfully completed the implementation plan with all required changes.' }], usage: { input_tokens: 1, output_tokens: 1 } }) } as unknown as LlmGateway;
    const loop = new RuntimeExecutionLoop();
    const response = await loop.resume({
      session,
      body: { messages: [] },
      requestedModel: 'claude-test',
      route: makeRoute(),
      requestId: 'req-3',
      token: 'token',
      startedAt: Date.now(),
      context: { summary: 'summary', selectedFiles: [], rankedItems: [], repositoryFacts: [], toolSummary: [], memorySummary: [], tokenBudget: 2000 },
      runtimePlan: 'plan',
      sessions,
      execution,
      llm,
      planner: new Planner(),
      retry: new RuntimeRetryManager(),
      checkpoints,
      recovery,
      cancellation: new SessionCancellationSignal(repository, session),
      toolExecutor: tooling.executor,
      toolRegistry: tooling.registry,
      memory: new MemoryManager(),
    });

    expect(response.status).toBe(200);
    expect(session.runtimeHistory.some((entry) => entry.state === 'Recovering')).toBe(true);
    expect(session.runtimeState).toBe('Completed');
  });

  it('executes tool calls and continues the reasoning loop', async () => {
    const repository = new InMemorySessionRepository();
    const session = await makeSession(repository);
    const sessions = new SessionManager(repository, new RuntimeLoggingEngine());
    const memory = new MemoryManager();
    const execution = new ExecutionEngine(
      new TaskScheduler(new TaskGraphEngine()),
      sessions,
      new ValidationEngine(),
      new ReflectionEngine(),
      memory,
      new ArtifactManager(),
      new RuntimeEventBus(),
    );
    const tooling = makeTooling();
    const llm = {
      execute: jest
        .fn()
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', id: 'tool-1', name: 'filesystem_read', input: { path: 'package.json' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Read complete.' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
        }),
    } as unknown as LlmGateway;
    const loop = new RuntimeExecutionLoop();
    const response = await loop.run({
      session,
      body: { messages: [], tools: tooling.registry.anthropicToolSchemas() },
      requestedModel: 'claude-test',
      route: makeRoute(),
      requestId: 'req-4',
      token: 'token',
      startedAt: Date.now(),
      context: { summary: 'summary', selectedFiles: [], rankedItems: [], repositoryFacts: [], toolSummary: [], memorySummary: [], tokenBudget: 2000 },
      runtimePlan: 'plan',
      sessions,
      execution,
      llm,
      planner: new Planner(),
      retry: new RuntimeRetryManager(),
      checkpoints: new CheckpointManager(),
      recovery: new RecoveryManager(),
      cancellation: new SessionCancellationSignal(repository, session),
      toolExecutor: tooling.executor,
      toolRegistry: tooling.registry,
      memory,
    });

    expect(response.status).toBe(200);
    expect((llm.execute as jest.Mock).mock.calls).toHaveLength(2);
    expect(session.memory.toolExecutionFacts.some((entry) => entry.value.includes('filesystem_read returned success'))).toBe(true);
    expect(session.runtimeHistory.some((entry) => entry.state === 'Waiting Tool')).toBe(true);
  });

  it('moves into Waiting Approval when a mutating tool call needs approval', async () => {
    const repository = new InMemorySessionRepository();
    const session = await makeSession(repository);
    const sessions = new SessionManager(repository, new RuntimeLoggingEngine());
    const memory = new MemoryManager();
    const execution = new ExecutionEngine(
      new TaskScheduler(new TaskGraphEngine()),
      sessions,
      new ValidationEngine(),
      new ReflectionEngine(),
      memory,
      new ArtifactManager(),
      new RuntimeEventBus(),
    );
    const tooling = makeTooling();
    const llm = {
      execute: jest.fn().mockResolvedValue({
        content: [{ type: 'tool_use', id: 'tool-2', name: 'filesystem_write', input: { path: 'package.json', content: '{}' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'tool_use',
      }),
    } as unknown as LlmGateway;
    const loop = new RuntimeExecutionLoop();

    const response = await loop.run({
      session,
      body: { messages: [], tools: tooling.registry.anthropicToolSchemas() },
      requestedModel: 'claude-test',
      route: makeRoute(),
      requestId: 'req-5',
      token: 'token',
      startedAt: Date.now(),
      context: { summary: 'summary', selectedFiles: [], rankedItems: [], repositoryFacts: [], toolSummary: [], memorySummary: [], tokenBudget: 2000 },
      runtimePlan: 'plan',
      sessions,
      execution,
      llm,
      planner: new Planner(),
      retry: new RuntimeRetryManager(),
      checkpoints: new CheckpointManager(),
      recovery: new RecoveryManager(),
      cancellation: new SessionCancellationSignal(repository, session),
      toolExecutor: tooling.executor,
      toolRegistry: tooling.registry,
      memory,
    });

    expect(response.status).toBe(409);
    expect(session.runtimeState).toBe('Waiting Approval');
  });
});
