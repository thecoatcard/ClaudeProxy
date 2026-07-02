import type { AgentSession } from './contracts';
import { CheckpointManager } from './checkpoint-manager';

export interface RollbackResult {
  success: boolean;
  rolledBackFiles: string[];
  errors: string[];
}

/**
 * RecoveryManager coordinates failure annotation, session state restoration,
 * and file-level rollback for the Agent Runtime.
 *
 * DESIGN:
 * - annotateFailure(): Records the error in session memory with high importance.
 * - restore(): Restores session state from the most recent valid checkpoint.
 * - rollback(): Attempts git-based rollback of all files modified in the session.
 *   Falls back gracefully if git is not available.
 * - createRollbackPlan(): Returns the list of files that would be rolled back.
 *
 * ROLLBACK STRATEGY:
 * 1. Identify all files in session.modifiedFiles.
 * 2. For each file, run `git checkout HEAD -- <file>` to restore the last committed state.
 * 3. If git is unavailable or a file was untracked, skip that file and record the error.
 * 4. Emit a structured RollbackResult so the runtime loop can decide next steps.
 */
export class RecoveryManager {
  constructor(private readonly checkpoints = new CheckpointManager()) {}

  annotateFailure(session: AgentSession, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    session.lastError = message;
    session.memory.sessionNotes = [
      ...session.memory.sessionNotes.slice(-23),
      {
        type: 'session',
        value: `Recovery recorded failure: ${message}`,
        source: 'recovery-manager',
        score: 0.9,
        createdAt: Date.now(),
      },
    ];
    return message;
  }

  restore(session: AgentSession) {
    const checkpoint = this.checkpoints.restoreLatest(session);
    if (!checkpoint) {
      return null;
    }
    session.memory.sessionNotes = [
      ...session.memory.sessionNotes.slice(-23),
      {
        type: 'session',
        value: `Recovered from checkpoint "${checkpoint.label}" (id=${checkpoint.id})`,
        source: 'recovery-manager',
        score: 0.95,
        createdAt: Date.now(),
      },
    ];
    return checkpoint;
  }

  /**
   * Returns the list of files that would be affected by a rollback.
   */
  createRollbackPlan(session: AgentSession): string[] {
    return [...new Set(session.modifiedFiles)];
  }

  /**
   * Attempts to roll back all files modified during the session using git.
   * Does NOT throw — records errors in the result and continues.
   */
  async rollback(session: AgentSession): Promise<RollbackResult> {
    const files = this.createRollbackPlan(session);
    if (files.length === 0) {
      return { success: true, rolledBackFiles: [], errors: [] };
    }

    const hasGit = await this.hasGitRepository(session.workspace.root);
    if (!hasGit) {
      return {
        success: false,
        rolledBackFiles: [],
        errors: ['Git repository not found. File rollback requires a git repository.'],
      };
    }

    const rolledBackFiles: string[] = [];
    const errors: string[] = [];

    for (const filePath of files) {
      try {
        await this.gitCheckout(session.workspace.root, filePath);
        rolledBackFiles.push(filePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to rollback "${filePath}": ${message}`);
      }
    }

    const success = errors.length === 0;

    session.memory.sessionNotes = [
      ...session.memory.sessionNotes.slice(-23),
      {
        type: 'session',
        value: success
          ? `Rollback succeeded: ${rolledBackFiles.length} file(s) restored.`
          : `Rollback partial: ${rolledBackFiles.length} restored, ${errors.length} errors.`,
        source: 'recovery-manager',
        score: success ? 0.9 : 0.6,
        createdAt: Date.now(),
      },
    ];

    return { success, rolledBackFiles, errors };
  }

  private async hasGitRepository(root: string): Promise<boolean> {
    try {
      const { spawn } = await import('node:child_process');
      return await new Promise<boolean>((resolve) => {
        const child = spawn('git', ['rev-parse', '--git-dir'], { cwd: root, windowsHide: true, shell: false });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
        setTimeout(() => { child.kill(); resolve(false); }, 3_000);
      });
    } catch {
      return false;
    }
  }

  private async gitCheckout(root: string, filePath: string): Promise<void> {
    const { spawn } = await import('node:child_process');
    return new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['checkout', 'HEAD', '--', filePath], {
        cwd: root,
        windowsHide: true,
        shell: false,
      });
      const stderr: string[] = [];
      child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.join('').trim() || `git checkout exited with code ${code}`));
        }
      });
      child.on('error', reject);
      setTimeout(() => { child.kill(); reject(new Error('git checkout timed out')); }, 10_000);
    });
  }
}
