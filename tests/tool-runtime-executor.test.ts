import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpRuntime } from '@/lib/runtime/agent/mcp-runtime';
import { PermissionManager } from '@/lib/runtime/agent/permission-manager';
import { RuntimeEventBus } from '@/lib/runtime/agent/event-bus';
import { RuntimeLoggingEngine } from '@/lib/runtime/agent/logging-engine';
import { RuntimeObservability } from '@/lib/runtime/agent/runtime-observability';
import { createRuntimeToolAdapters } from '@/lib/runtime/agent/tool-adapters';
import { ToolExecutor } from '@/lib/runtime/agent/tool-executor';
import { ToolRegistry } from '@/lib/runtime/agent/tool-registry';
import type { AgentSession, RuntimeMemory, WorkspaceContext } from '@/lib/runtime/agent/contracts';

function makeSession(root: string): AgentSession {
  const workspace: WorkspaceContext = {
    root,
    packageManager: 'npm',
    projectType: 'test',
    language: 'typescript',
    framework: 'nextjs',
    configFiles: [],
    entryPoints: [],
    buildCommand: 'npm run build',
    testCommand: 'echo ok',
  };
  const memory: RuntimeMemory = {
    sessionNotes: [],
    projectFacts: [],
    semanticFacts: [],
    longTermFacts: [],
    architectureFacts: [],
    conversationFacts: [],
    toolExecutionFacts: [],
    selectedFiles: [],
  };
  return {
    id: 'session-1',
    ownerId: 'owner-1',
    version: 1,
    requestedModel: 'test',
    goal: { objective: 'test tools', missingInformation: [], requiredTools: [], expectedOutputs: [], constraints: [] },
    workspace,
    status: 'RUNNING',
    currentState: 'tool-test',
    tasks: [],
    completedTasks: [],
    pendingTasks: [],
    runningTasks: [],
    modifiedFiles: [],
    logs: [],
    runtimeState: 'Executing',
    runtimeHistory: [{ at: Date.now(), state: 'Executing', detail: 'test session' }],
    browserState: {},
    gitState: {},
    memory,
    checkpoints: [],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('tool runtime executor', () => {
  it('registers runtime adapters including docker and mcp', () => {
    const mcp = new McpRuntime();
    const registry = new ToolRegistry(new PermissionManager(), createRuntimeToolAdapters(mcp));
    const capabilities = registry.listCapabilities();
    expect(capabilities.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['filesystem', 'shell', 'git', 'browser', 'docker', 'database', 'http', 'mcp']),
    );
  });

  it('executes safe filesystem read through the executor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tool-runtime-'));
    try {
      const file = path.join(root, 'note.txt');
      await writeFile(file, 'hello runtime', 'utf8');
      const session = makeSession(root);
      const mcp = new McpRuntime();
      const registry = new ToolRegistry(new PermissionManager(), createRuntimeToolAdapters(mcp));
      const executor = new ToolExecutor(
        registry,
        new PermissionManager(),
        new RuntimeEventBus(),
        new RuntimeLoggingEngine(),
        new RuntimeObservability(),
      );

      const result = await executor.execute(
        session,
        { adapter: 'filesystem', operation: 'read', input: { path: 'note.txt' } },
        { sessionId: session.id, ownerId: session.ownerId, workspaceRoot: root, requestId: 'req-1' },
      );

      expect(result.status).toBe('success');
      expect(result.output?.content).toBe('hello runtime');
      expect(session.memory.toolExecutionFacts.at(-1)?.value).toContain('filesystem:read:success');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires approval for dangerous filesystem delete operations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tool-runtime-'));
    try {
      const file = path.join(root, 'note.txt');
      await writeFile(file, 'delete me', 'utf8');
      const session = makeSession(root);
      const mcp = new McpRuntime();
      const registry = new ToolRegistry(new PermissionManager(), createRuntimeToolAdapters(mcp));
      const executor = new ToolExecutor(
        registry,
        new PermissionManager(),
        new RuntimeEventBus(),
        new RuntimeLoggingEngine(),
        new RuntimeObservability(),
      );

      const result = await executor.execute(
        session,
        { adapter: 'filesystem', operation: 'delete', input: { path: 'note.txt' } },
        { sessionId: session.id, ownerId: session.ownerId, workspaceRoot: root, requestId: 'req-2' },
      );

      expect(result.status).toBe('approval_required');
      expect(await readFile(file, 'utf8')).toBe('delete me');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports MCP tool execution through the common executor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tool-runtime-'));
    try {
      const mcp = new McpRuntime();
      mcp.registerTool({
        name: 'echo',
        description: 'echo',
        handler: async (input) => ({ echoed: input.value }),
      });
      const registry = new ToolRegistry(new PermissionManager(), createRuntimeToolAdapters(mcp));
      const executor = new ToolExecutor(
        registry,
        new PermissionManager({ autoApproveSafe: true, autoApproveConfirmationRequired: false, allowedDangerousOperations: [] }),
        new RuntimeEventBus(),
        new RuntimeLoggingEngine(),
        new RuntimeObservability(),
      );
      const session = makeSession(root);
      const result = await executor.execute(
        session,
        { adapter: 'mcp', operation: 'tool', input: { name: 'echo', input: { value: 'hello' } } },
        { sessionId: session.id, ownerId: session.ownerId, workspaceRoot: root, requestId: 'req-3' },
      );
      expect(result.status).toBe('success');
      expect(result.output?.result).toEqual({ echoed: 'hello' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('populates session.modifiedFiles when a mutating filesystem write succeeds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tool-runtime-'));
    try {
      const session = makeSession(root);
      const mcp = new McpRuntime();
      const registry = new ToolRegistry(new PermissionManager(), createRuntimeToolAdapters(mcp));
      const executor = new ToolExecutor(
        registry,
        new PermissionManager({ autoApproveSafe: true, autoApproveConfirmationRequired: true, allowedDangerousOperations: [] }),
        new RuntimeEventBus(),
        new RuntimeLoggingEngine(),
        new RuntimeObservability(),
      );
      const result = await executor.execute(
        session,
        { adapter: 'filesystem', operation: 'write', input: { path: 'note.txt', content: 'mutated content' } },
        { sessionId: session.id, ownerId: session.ownerId, workspaceRoot: root, requestId: 'req-write' },
      );
      expect(result.status).toBe('success');
      expect(session.modifiedFiles).toContain('note.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns cancelled when the runtime cancellation signal is set', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tool-runtime-'));
    try {
      const session = makeSession(root);
      const mcp = new McpRuntime();
      const registry = new ToolRegistry(new PermissionManager(), createRuntimeToolAdapters(mcp));
      const executor = new ToolExecutor(
        registry,
        new PermissionManager(),
        new RuntimeEventBus(),
        new RuntimeLoggingEngine(),
        new RuntimeObservability(),
      );
      const result = await executor.execute(
        session,
        { adapter: 'filesystem', operation: 'read', input: { path: 'missing.txt' } },
        {
          sessionId: session.id,
          ownerId: session.ownerId,
          workspaceRoot: root,
          requestId: 'req-4',
          cancellation: {
            cancelled: true,
            reason: 'cancelled',
            throwIfCancelled() {
              throw new Error('cancelled');
            },
          },
        },
      );
      expect(result.status).toBe('cancelled');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
