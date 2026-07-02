import { mkdtemp, rm } from 'node:fs/promises';
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
import { ValidationEngine } from '@/lib/runtime/agent/validation-engine';
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
    id: 'session-validation',
    ownerId: 'owner',
    version: 1,
    requestedModel: 'test',
    goal: { objective: 'validate runtime', missingInformation: [], requiredTools: ['shell'], expectedOutputs: [], constraints: [] },
    workspace,
    status: 'RUNNING',
    currentState: 'validation',
    tasks: [],
    completedTasks: ['model-execution'],
    pendingTasks: [],
    runningTasks: [],
    modifiedFiles: ['src/index.ts'],
    logs: [],
    runtimeState: 'Executing',
    runtimeHistory: [{ at: Date.now(), state: 'Executing', detail: 'validation test' }],
    browserState: {},
    gitState: {},
    memory,
    checkpoints: [],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('agent runtime validation tool integration', () => {
  it('runs validation through the tool executor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tool-validation-'));
    try {
      const session = makeSession(root);
      const permissions = new PermissionManager({
        autoApproveSafe: true,
        autoApproveConfirmationRequired: true,
        allowedDangerousOperations: [],
      });
      const registry = new ToolRegistry(permissions, createRuntimeToolAdapters(new McpRuntime()));
      const executor = new ToolExecutor(
        registry,
        permissions,
        new RuntimeEventBus(),
        new RuntimeLoggingEngine(),
        new RuntimeObservability(),
      );
      const validation = new ValidationEngine(executor);
      const result = await validation.validate(session);
      expect(result.status).toBe('passed');
      expect(result.checks).toContain('runtime_tool_validation');
      expect(result.details.join(' ')).toContain('Runtime tool validation result: success');
      expect(session.memory.toolExecutionFacts.at(-1)?.value).toContain('shell:exec:success');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
