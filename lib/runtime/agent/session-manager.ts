import type {
  AgentSession,
  AgentSessionRepository,
  AgentSessionStatus,
  CreateSessionInput,
  RuntimeLifecycleState,
  SessionCheckpoint,
} from './contracts';
import { RuntimeLoggingEngine } from './logging-engine';
import { assertRuntimeTransition, statusForRuntimeState } from './state-machine';

export class SessionManager {
  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly logger: RuntimeLoggingEngine,
  ) {}

  create(input: CreateSessionInput) {
    return this.repository.create(input);
  }

  async transition(session: AgentSession, status: AgentSessionStatus, currentState: string, metadata?: Record<string, unknown>) {
    session.status = status;
    session.currentState = currentState;
    this.logger.info(session, currentState, metadata);
    await this.repository.save(session);
    await this.repository.appendEvent({
      ownerId: session.ownerId,
      sessionId: session.id,
      sequence: session.version,
      type: 'SESSION_TRANSITION',
      data: { status, currentState, ...metadata },
    });
  }

  async transitionRuntimeState(
    session: AgentSession,
    runtimeState: RuntimeLifecycleState,
    detail: string,
    metadata?: Record<string, unknown>,
  ) {
    if (session.runtimeState !== runtimeState) {
      assertRuntimeTransition(session.runtimeState, runtimeState);
    }
    session.runtimeState = runtimeState;
    session.runtimeHistory = [
      ...session.runtimeHistory.slice(-199),
      { at: Date.now(), state: runtimeState, detail, metadata },
    ];
    const status = statusForRuntimeState(runtimeState);
    await this.transition(session, status, detail, {
      runtimeState,
      ...(metadata ?? {}),
    });
    await this.repository.appendEvent({
      ownerId: session.ownerId,
      sessionId: session.id,
      sequence: session.version,
      type: 'RUNTIME_STATE_CHANGED',
      data: { runtimeState, detail, ...(metadata ?? {}) },
    });
  }

  async appendCheckpoint(session: AgentSession, checkpoint: SessionCheckpoint) {
    session.checkpoints = [...session.checkpoints.slice(-49), checkpoint];
    await this.repository.save(session);
    await this.repository.appendEvent({
      ownerId: session.ownerId,
      sessionId: session.id,
      sequence: session.version,
      type: 'CHECKPOINT_CREATED',
      data: { checkpointId: checkpoint.id, label: checkpoint.label, runtimeState: checkpoint.lifecycleState },
    });
  }

  async startTask(session: AgentSession, taskId: string) {
    const task = session.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    task.status = 'RUNNING';
    task.startedAt = Date.now();
    task.attempts = (task.attempts ?? 0) + 1;
    session.pendingTasks = session.pendingTasks.filter((candidate) => candidate !== taskId);
    session.runningTasks = Array.from(new Set([...session.runningTasks, taskId]));
    await this.repository.save(session);
    await this.repository.appendEvent({
      ownerId: session.ownerId,
      sessionId: session.id,
      sequence: session.version,
      type: 'TASK_STARTED',
      data: { taskId, attempts: task.attempts },
    });
  }

  async finishTask(session: AgentSession, taskId: string, output?: Record<string, unknown>) {
    const task = session.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    task.status = 'COMPLETED';
    task.output = output;
    task.completedAt = Date.now();
    session.runningTasks = session.runningTasks.filter((candidate) => candidate !== taskId);
    session.completedTasks = Array.from(new Set([...session.completedTasks, taskId]));
    await this.repository.save(session);
    await this.repository.appendEvent({
      ownerId: session.ownerId,
      sessionId: session.id,
      sequence: session.version,
      type: 'TASK_COMPLETED',
      data: { taskId, output: output ?? {} },
    });
  }

  async failTask(session: AgentSession, taskId: string, error: string) {
    const task = session.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    task.status = 'FAILED';
    task.error = error;
    task.completedAt = Date.now();
    session.lastError = error;
    session.runningTasks = session.runningTasks.filter((candidate) => candidate !== taskId);
    await this.repository.save(session);
    await this.repository.appendEvent({
      ownerId: session.ownerId,
      sessionId: session.id,
      sequence: session.version,
      type: 'TASK_FAILED',
      data: { taskId, error },
    });
  }

  async resetTaskForRetry(session: AgentSession, taskId: string, reason: string) {
    const task = session.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    task.status = 'PENDING';
    task.error = reason;
    task.startedAt = undefined;
    task.completedAt = undefined;
    session.runningTasks = session.runningTasks.filter((candidate) => candidate !== taskId);
    if (!session.pendingTasks.includes(taskId)) {
      session.pendingTasks = [...session.pendingTasks, taskId];
    }
    await this.repository.save(session);
    await this.repository.appendEvent({
      ownerId: session.ownerId,
      sessionId: session.id,
      sequence: session.version,
      type: 'TASK_REQUEUED',
      data: { taskId, reason },
    });
  }

  async cancel(session: AgentSession, reason = 'Cancellation requested') {
    session.cancellationRequestedAt = Date.now();
    session.status = 'CANCELLED';
    session.runtimeState = 'Cancelled';
    session.currentState = 'cancelled';
    session.runtimeHistory = [
      ...session.runtimeHistory.slice(-199),
      { at: Date.now(), state: 'Cancelled', detail: reason },
    ];
    this.logger.warn(session, 'session_cancelled', { reason });
    await this.repository.save(session);
    await this.repository.appendEvent({
      ownerId: session.ownerId,
      sessionId: session.id,
      sequence: session.version,
      type: 'SESSION_CANCELLED',
      data: { reason },
    });
  }
}
