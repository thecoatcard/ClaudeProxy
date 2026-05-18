/**
 * lib/agent/subagent-memory.ts
 *
 * Stores and retrieves active subagent tasks in Redis so they survive
 * context compaction.  Each orchestrated task owns a set of subagent records.
 */

import { redis } from '@/lib/redis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubagentStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface SubagentExecutionSnapshot {
  model: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retries: number;
  success: boolean;
  error?: string;
  updatedAt: number;
}

export interface SubagentTask {
  /** Unique task identifier (uuid v4 recommended). */
  id: string;
  /** Parent orchestrator task id. */
  parentId: string;
  /** The user key that owns this task. */
  owner: string;
  /** Human-readable description. */
  description: string;
  /** Explicit dependency task ids that must complete first. */
  dependencies: string[];
  /** Current status. */
  status: SubagentStatus;
  /** Assigned model for this sub-task. */
  model: string;
  /** Artifacts produced (file paths, URLs, content hashes, etc.). */
  artifacts: string[];
  /** Epoch ms when task was created. */
  createdAt: number;
  /** Epoch ms when status last changed. */
  updatedAt: number;
  /** Epoch ms when the task completed (null until then). */
  completedAt: number | null;
  /** Durable execution snapshot used for resume/merge reconstruction. */
  execution: SubagentExecutionSnapshot | null;
}

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'subagent:task';
const PARENT_INDEX_PREFIX = 'subagent:parent';
/** Default TTL: 24 h — long enough to outlast context compaction windows. */
const DEFAULT_TTL_SECONDS = 86_400;

function taskKey(taskId: string): string {
  return `${KEY_PREFIX}:${taskId}`;
}

function parentIndexKey(parentId: string): string {
  return `${PARENT_INDEX_PREFIX}:${parentId}`;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Persist a new subagent task.  If a task with the same id already exists it
 * is overwritten, so this doubles as an upsert.
 */
export async function saveSubagentTask(task: SubagentTask): Promise<void> {
  try {
    const key = taskKey(task.id);
    await (redis as any).set(key, JSON.stringify(task), { ex: DEFAULT_TTL_SECONDS });
    // Maintain a Redis Set that maps parentId → [childId, …]
    await (redis as any).sadd(parentIndexKey(task.parentId), task.id).catch(() => {});
    await (redis as any).expire(parentIndexKey(task.parentId), DEFAULT_TTL_SECONDS).catch(() => {});
  } catch (err) {
    console.warn('[SubagentMemory] saveSubagentTask failed:', err);
  }
}

/**
 * Update the status (and optional artifacts) of an existing task.
 */
export async function updateSubagentStatus(
  taskId: string,
  status: SubagentStatus,
  artifacts?: string[]
): Promise<void> {
  const task = await getSubagentTask(taskId);
  if (!task) {
    console.warn(`[SubagentMemory] updateSubagentStatus: task ${taskId} not found`);
    return;
  }
  const updated: SubagentTask = {
    ...task,
    status,
    updatedAt: Date.now(),
    completedAt:
      status === 'COMPLETED' || status === 'FAILED' || status === 'SKIPPED'
        ? Date.now()
        : task.completedAt,
    artifacts: artifacts !== undefined ? artifacts : task.artifacts,
  };
  await saveSubagentTask(updated);
}

/**
 * Persist the latest execution snapshot for a task.
 * This checkpoint allows deterministic resume/merge without re-running work.
 */
export async function saveSubagentExecution(
  taskId: string,
  execution: Omit<SubagentExecutionSnapshot, 'updatedAt'>,
): Promise<void> {
  const task = await getSubagentTask(taskId);
  if (!task) {
    console.warn(`[SubagentMemory] saveSubagentExecution: task ${taskId} not found`);
    return;
  }

  const now = Date.now();
  const status: SubagentStatus = execution.success ? 'COMPLETED' : 'FAILED';
  const updated: SubagentTask = {
    ...task,
    status,
    updatedAt: now,
    completedAt: status === 'COMPLETED' || status === 'FAILED' ? now : task.completedAt,
    execution: {
      ...execution,
      updatedAt: now,
    },
  };
  await saveSubagentTask(updated);
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export async function getSubagentTask(taskId: string): Promise<SubagentTask | null> {
  try {
    const raw = await (redis as any).get(taskKey(taskId));
    if (!raw) return null;
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as SubagentTask;
  } catch {
    return null;
  }
}

/**
 * Return all child tasks for a given parent orchestrator task id.
 */
export async function getSubagentTasksByParent(parentId: string): Promise<SubagentTask[]> {
  try {
    const childIds: string[] = await (redis as any).smembers(parentIndexKey(parentId)).catch(() => []);
    const tasks = await Promise.all(childIds.map((id) => getSubagentTask(id)));
    return tasks.filter((t): t is SubagentTask => t !== null);
  } catch {
    return [];
  }
}

/**
 * Delete a subagent task and remove it from the parent index.
 */
export async function deleteSubagentTask(taskId: string): Promise<void> {
  const task = await getSubagentTask(taskId);
  try {
    await (redis as any).del(taskKey(taskId)).catch(() => {});
    if (task) {
      await (redis as any).srem(parentIndexKey(task.parentId), taskId).catch(() => {});
    }
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

let _taskIdCounter = 0;

/** Create a new SubagentTask record (not yet persisted). Call saveSubagentTask() to persist. */
export function createSubagentTask(params: {
  parentId: string;
  owner: string;
  description: string;
  model: string;
  dependencies?: string[];
}): SubagentTask {
  const now = Date.now();
  return {
    id: `${now}-${++_taskIdCounter}-${Math.random().toString(36).slice(2, 8)}`,
    parentId: params.parentId,
    owner: params.owner,
    description: params.description,
    model: params.model,
    dependencies: params.dependencies ?? [],
    status: 'PENDING',
    artifacts: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    execution: null,
  };
}
