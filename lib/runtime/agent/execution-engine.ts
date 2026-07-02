import type { AgentSession, ModelExecutionResponse, ValidationResult } from './contracts';
import { ArtifactManager } from './artifact-manager';
import { RuntimeEventBus } from './event-bus';
import { MemoryManager } from './memory-manager';
import { ReflectionEngine } from './reflection-engine';
import { SessionManager } from './session-manager';
import { TaskScheduler } from './task-scheduler';
import { ValidationEngine } from './validation-engine';

export class ExecutionEngine {
  constructor(
    private readonly scheduler: TaskScheduler,
    private readonly sessions: SessionManager,
    private readonly validation: ValidationEngine,
    private readonly reflection: ReflectionEngine,
    private readonly memory: MemoryManager,
    private readonly artifacts: ArtifactManager,
    private readonly events: RuntimeEventBus,
  ) {}

  schedule(session: AgentSession) {
    return this.scheduler.build(session.tasks);
  }

  async completeInformationalTask(session: AgentSession, taskId: string, output: Record<string, unknown>) {
    await this.events.emit('TaskStarted', { taskId }, session.id);
    await this.sessions.startTask(session, taskId);
    this.memory.update(session.memory, `${taskId} completed`, taskId, 'session', 0.7);
    await this.sessions.finishTask(session, taskId, output);
    await this.events.emit('TaskCompleted', { taskId, output }, session.id);
  }

  async finalizeSession(session: AgentSession, response: ModelExecutionResponse): Promise<ValidationResult> {
    await this.sessions.transition(session, 'VALIDATING', 'running_validation');
    await this.events.emit('ValidationStarted', {}, session.id);

    const validation = await this.validation.validate(session);
    await this.sessions.startTask(session, 'validation');
    await this.sessions.finishTask(session, 'validation', {
      status: validation.status,
      checks: validation.checks,
      details: validation.details,
    });
    await this.events.emit('ValidationCompleted', validation as unknown as Record<string, unknown>, session.id);

    await this.sessions.startTask(session, 'reflection');
    const reflection = this.reflection.reflect(session, response, validation);
    await this.sessions.finishTask(session, 'reflection', reflection as unknown as Record<string, unknown>);
    await this.events.emit('ReflectionCompleted', reflection as unknown as Record<string, unknown>, session.id);

    await this.sessions.startTask(session, 'memory-update');
    this.memory.update(
      session.memory,
      `Execution finished with validation=${validation.status}`,
      'execution-engine',
      'session',
      0.8,
    );
    await this.sessions.finishTask(session, 'memory-update', { noteCount: session.memory.sessionNotes.length });

    await this.sessions.startTask(session, 'completion');
    this.artifacts.create(session, {
      type: 'report',
      label: 'runtime-summary',
      metadata: {
        validation: validation.status,
        completedTasks: session.completedTasks.length,
      },
    });
    await this.sessions.finishTask(session, 'completion', {
      artifacts: session.artifacts.length,
      completedTasks: session.completedTasks.length,
    });

    await this.sessions.transition(
      session,
      reflection.success ? 'COMPLETED' : 'FAILED',
      reflection.success ? 'session_completed' : 'session_failed',
      {
        reflection: reflection.summary,
        qualityScore: reflection.qualityScore,
        shouldReplan: reflection.shouldReplan,
        shouldRetry: reflection.shouldRetry,
      },
    );
    // Store the full reflection result on the session so the runtime loop can read
    // shouldReplan / shouldRetry signals without tight coupling to the execution engine.
    session.lastReflection = {
      ...reflection as unknown as Record<string, unknown>,
      status: validation.status,
      checks: validation.checks,
      details: validation.details,
    };
    await this.events.emit('SessionFinished', {
      success: reflection.success,
      summary: reflection.summary,
      qualityScore: reflection.qualityScore,
      shouldReplan: reflection.shouldReplan,
      shouldRetry: reflection.shouldRetry,
      signals: reflection.signals,
    }, session.id);
    if (reflection.success) {
      session.completedAt = Date.now();
    }
    return validation;
  }
}
