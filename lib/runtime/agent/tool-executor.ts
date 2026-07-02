import type { AgentSession, ToolContext, ToolInvocation, ToolResult } from './contracts';
import { PermissionManager } from './permission-manager';
import { RuntimeEventBus } from './event-bus';
import { RuntimeLoggingEngine } from './logging-engine';
import { RuntimeObservability } from './runtime-observability';
import { SessionManager } from './session-manager';
import { ToolRegistry } from './tool-registry';

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionManager,
    private readonly events: RuntimeEventBus,
    private readonly logger: RuntimeLoggingEngine,
    private readonly observability: RuntimeObservability,
  ) {}

  async execute(session: AgentSession, invocation: ToolInvocation, context: ToolContext, sessions?: SessionManager): Promise<ToolResult> {
    // Check for cancellation before executing
    try {
      context.cancellation?.throwIfCancelled();
    } catch (error) {
      return {
        status: 'cancelled',
        adapter: invocation.adapter,
        operation: invocation.operation,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        audit: {
          adapter: invocation.adapter,
          operation: invocation.operation,
          permission: 'safe',
          startedAt: Date.now(),
          completedAt: Date.now(),
          durationMs: 0,
        },
      };
    }

    const adapter = this.registry.get(invocation.adapter);
    if (!adapter) {
      return {
        status: 'error',
        adapter: invocation.adapter,
        operation: invocation.operation,
        error: `Unknown tool adapter: ${invocation.adapter}`,
        logs: [],
        audit: {
          adapter: invocation.adapter,
          operation: invocation.operation,
          permission: 'safe',
          startedAt: Date.now(),
          completedAt: Date.now(),
          durationMs: 0,
        },
      };
    }

    // Session-scoped permission evaluation (context.ownerId and context.workspaceRoot are used)
    const decision = this.permissions.evaluate(invocation, context);
    if (!decision.approved) {
      this.logger.warn(session, 'tool_approval_required', { adapter: invocation.adapter, operation: invocation.operation });
      await this.events.emit('ToolApprovalRequested', {
        adapter: invocation.adapter,
        operation: invocation.operation,
        permission: decision.permission,
      }, session.id);
      return {
        status: 'approval_required',
        adapter: invocation.adapter,
        operation: invocation.operation,
        logs: [],
        approval: decision.approval,
        audit: {
          adapter: invocation.adapter,
          operation: invocation.operation,
          permission: decision.permission,
          startedAt: Date.now(),
          completedAt: Date.now(),
          durationMs: 0,
        },
      };
    }

    const startedAt = Date.now();
    await this.events.emit('ToolExecutionStarted', { adapter: invocation.adapter, operation: invocation.operation }, session.id);
    this.logger.info(session, 'tool_execution_started', { adapter: invocation.adapter, operation: invocation.operation });
    const result = await adapter.execute(invocation, context);
    result.audit.permission = decision.permission;

    const durationMs = Date.now() - startedAt;
    this.observability.increment(`tool.${invocation.adapter}.${result.status}`);
    this.observability.recordDuration(`tool.${invocation.adapter}.latency`, durationMs);

    // Track modified files for filesystem write operations
    if (result.status === 'success' && invocation.adapter === 'filesystem') {
      const target = typeof invocation.input.path === 'string' ? invocation.input.path : undefined;
      if (target && ['write', 'delete', 'move', 'mkdir'].includes(invocation.operation)) {
        if (!session.modifiedFiles.includes(target)) {
          session.modifiedFiles = [...session.modifiedFiles, target];
        }
        if (invocation.operation === 'move' && typeof invocation.input.destination === 'string') {
          if (!session.modifiedFiles.includes(invocation.input.destination)) {
            session.modifiedFiles = [...session.modifiedFiles, invocation.input.destination];
          }
        }
      }
    }

    // Persist tool execution fact to session memory via session notes
    // (respects memory ownership — MemoryManager pattern)
    session.memory.toolExecutionFacts = [
      ...session.memory.toolExecutionFacts.slice(-23),
      {
        type: 'tool_execution',
        value: `${invocation.adapter}:${invocation.operation}:${result.status}`,
        source: 'tool-executor',
        score: result.status === 'success' ? 0.8 : 0.4,
        createdAt: Date.now(),
      },
    ];

    // Persist tool state to session store
    if (sessions) {
      await sessions.transition(session, session.status, `tool_${result.status}`, {
        adapter: invocation.adapter,
        operation: invocation.operation,
        resultStatus: result.status,
        durationMs,
      });
    }

    await this.events.emit(
      result.status === 'success' ? 'ToolExecutionCompleted' : 'ToolExecutionFailed',
      { adapter: invocation.adapter, operation: invocation.operation, status: result.status, error: result.error, durationMs },
      session.id,
    );
    return result;
  }
}
