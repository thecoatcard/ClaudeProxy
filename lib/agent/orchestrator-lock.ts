/**
 * lib/agent/orchestrator-lock.ts
 *
 * Phase 2: Orchestration deduplication — prevent duplicate orchestrations for
 *          the same request fingerprint.
 * Phase 3: Subagent reuse — if a parent already has subagent tasks in Redis,
 *          reuse them rather than regenerating.
 *
 * Fingerprint = SHA-256(userId + firstUserMessage + model)
 * TTL = 5 minutes (enough to cover a normal long request).
 */

import { createHash } from 'crypto';
import {
  setFingerprintParent,
  getFingerprintParent,
  getOrchestrationRecord,
  isTerminalState,
} from './orchestrator-state';
import { getSubagentTasksByParent } from './subagent-memory';
import type { SubagentTask } from './subagent-memory';

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

export function buildRequestFingerprint(
  userId: string,
  requestBody: Record<string, unknown>
): string {
  const model = (requestBody.model as string) ?? '';
  const messages = requestBody.messages as Array<{ role: string; content: string }> | undefined;
  const firstUser = messages?.find((m) => m.role === 'user')?.content ?? '';
  const raw = `${userId}:${model}:${firstUser.slice(0, 512)}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Deduplication check (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Check if an active orchestration already exists for this request fingerprint.
 *
 * Returns:
 *  - `{ reuse: true, parentId, tasks }` → caller should reuse this orchestration
 *  - `{ reuse: false }` → caller must start a new orchestration
 */
export async function checkOrchestrationDedup(
  fingerprint: string
): Promise<
  | { reuse: true; parentId: string; tasks: SubagentTask[] }
  | { reuse: false }
> {
  const existingParentId = await getFingerprintParent(fingerprint);
  if (!existingParentId) return { reuse: false };

  // Confirm the orchestration is still active (not terminal)
  const record = await getOrchestrationRecord(existingParentId);
  if (!record || isTerminalState(record.state)) return { reuse: false };

  // Phase 3: Load existing subagent tasks
  const tasks = await getSubagentTasksByParent(existingParentId);
  if (tasks.length === 0) return { reuse: false };

  console.info(
    `[orch-lock] Reusing existing orchestration ${existingParentId} (${tasks.length} tasks)`
  );
  return { reuse: true, parentId: existingParentId, tasks };
}

// ---------------------------------------------------------------------------
// Register a new fingerprint → parentId mapping (Phase 2)
// ---------------------------------------------------------------------------

export async function registerOrchestrationFingerprint(
  fingerprint: string,
  parentId: string
): Promise<string> {
  await setFingerprintParent(fingerprint, parentId);
  const resolvedParentId = await getFingerprintParent(fingerprint);
  return resolvedParentId || parentId;
}
