import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import type { AgentSession } from '@/lib/runtime/agent/contracts';

export async function runtimeOwner(req: Request) {
  const authorized = await validateAdminKey(req);
  if (!authorized) {
    return null;
  }

  return process.env.ADMIN_EMAIL?.trim() || 'admin';
}

export function dependencyError() {
  return NextResponse.json(
    {
      error: {
        code: 'RUNTIME_STORAGE_UNAVAILABLE',
        message: 'Runtime storage is unavailable',
      },
    },
    { status: 503 },
  );
}

export function sessionToRun(session: AgentSession) {
  return {
    id: session.id,
    ownerId: session.ownerId,
    objective: session.goal.objective,
    state: session.status,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    currentState: session.currentState,
    pendingTasks: session.pendingTasks,
    runningTasks: session.runningTasks,
    completedTasks: session.completedTasks,
    selectedFiles: session.memory.selectedFiles,
    modifiedFiles: session.modifiedFiles,
    checkpoints: session.checkpoints,
    artifacts: session.artifacts,
    lastError: session.lastError,
  };
}
