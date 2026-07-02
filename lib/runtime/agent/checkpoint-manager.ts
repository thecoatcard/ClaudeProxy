import { randomUUID } from 'node:crypto';
import type { AgentSession, SessionCheckpoint } from './contracts';

/**
 * Snapshot of the complete mutable session state at a point in time.
 * Used by CheckpointManager to enable full state restoration on recovery.
 */
interface SessionStateSnapshot {
  runtimeState: AgentSession['runtimeState'];
  currentState: string;
  status: AgentSession['status'];
  pendingTasks: string[];
  runningTasks: string[];
  completedTasks: string[];
  modifiedFiles: string[];
  artifacts: string[];
  memorySnapshot: {
    sessionNoteCount: number;
    toolExecutionFactCount: number;
    projectFactCount: number;
    lastSessionNoteValue?: string;
  };
  taskStates: Array<{
    id: string;
    status: AgentSession['tasks'][number]['status'];
    attempts?: number;
    error?: string;
  }>;
}

/**
 * CheckpointManager creates and restores complete session state snapshots.
 *
 * DESIGN:
 * - Checkpoints are stored in-session (in MongoDB via SessionManager.appendCheckpoint).
 * - Each checkpoint includes full task states, file mutation lists, memory metadata,
 *   and artifact lists — enabling complete state restoration after a crash or retry.
 * - `restoreLatest()` validates checkpoint integrity before applying it.
 * - `canRestoreFrom()` can be used to verify a specific checkpoint is restorable.
 */
export class CheckpointManager {
  create(session: AgentSession, label: string, metadata?: Record<string, unknown>): SessionCheckpoint {
    const stateSnapshot: SessionStateSnapshot = {
      runtimeState: session.runtimeState,
      currentState: session.currentState,
      status: session.status,
      pendingTasks: [...session.pendingTasks],
      runningTasks: [...session.runningTasks],
      completedTasks: [...session.completedTasks],
      modifiedFiles: [...session.modifiedFiles],
      artifacts: [...session.artifacts],
      memorySnapshot: {
        sessionNoteCount: session.memory.sessionNotes.length,
        toolExecutionFactCount: session.memory.toolExecutionFacts.length,
        projectFactCount: session.memory.projectFacts.length,
        lastSessionNoteValue: session.memory.sessionNotes.at(-1)?.value,
      },
      taskStates: session.tasks.map((task) => ({
        id: task.id,
        status: task.status,
        attempts: task.attempts,
        error: task.error,
      })),
    };

    const snapshot: SessionCheckpoint = {
      id: randomUUID(),
      at: Date.now(),
      label,
      lifecycleState: session.runtimeState,
      currentState: session.currentState,
      pendingTasks: [...session.pendingTasks],
      runningTasks: [...session.runningTasks],
      completedTasks: [...session.completedTasks],
      metadata: {
        ...(metadata ?? {}),
        stateSnapshot,
      },
    };

    session.checkpoints = [...session.checkpoints.slice(-49), snapshot];
    return snapshot;
  }

  latest(session: AgentSession): SessionCheckpoint | null {
    return session.checkpoints.at(-1) ?? null;
  }

  /**
   * Validates that a checkpoint contains sufficient data for a safe restore.
   */
  canRestoreFrom(checkpoint: SessionCheckpoint): boolean {
    if (!checkpoint.lifecycleState) return false;
    if (!Array.isArray(checkpoint.pendingTasks)) return false;
    if (!Array.isArray(checkpoint.completedTasks)) return false;
    const snapshot = checkpoint.metadata?.stateSnapshot as SessionStateSnapshot | undefined;
    if (!snapshot) return false;
    if (!Array.isArray(snapshot.taskStates)) return false;
    return true;
  }

  /**
   * Restore session state from the most recent valid checkpoint.
   * Returns the restored checkpoint, or null if no valid checkpoint exists.
   *
   * SAFETY: Validates the checkpoint before applying any mutations.
   * If the latest checkpoint is invalid, falls back to the previous one.
   */
  restoreLatest(session: AgentSession): SessionCheckpoint | null {
    const candidates = [...session.checkpoints].reverse();

    for (const checkpoint of candidates) {
      if (!this.canRestoreFrom(checkpoint)) continue;

      const snapshot = checkpoint.metadata?.stateSnapshot as SessionStateSnapshot;

      // Restore core task list and state tracking arrays
      session.runtimeState = checkpoint.lifecycleState;
      session.currentState = checkpoint.currentState;
      session.pendingTasks = [...checkpoint.pendingTasks];
      session.runningTasks = [...checkpoint.runningTasks];
      session.completedTasks = [...checkpoint.completedTasks];

      // Restore extended state from snapshot
      session.modifiedFiles = [...snapshot.modifiedFiles];
      session.artifacts = [...snapshot.artifacts];

      // Restore per-task status to checkpoint values (prevents stale RUNNING states)
      for (const taskState of snapshot.taskStates) {
        const task = session.tasks.find((t) => t.id === taskState.id);
        if (task) {
          task.status = taskState.status;
          task.attempts = taskState.attempts;
          task.error = taskState.error;
        }
      }

      // Reclassify any tasks that were RUNNING at checkpoint time as PENDING
      // (they were in-flight when the checkpoint was taken and must be retried)
      for (const task of session.tasks) {
        if (task.status === 'RUNNING') {
          task.status = 'PENDING';
          if (!session.pendingTasks.includes(task.id)) {
            session.pendingTasks = [...session.pendingTasks, task.id];
          }
          session.runningTasks = session.runningTasks.filter((id) => id !== task.id);
        }
      }

      return checkpoint;
    }

    return null;
  }
}
