/**
 * lib/agent/orchestrator-state.ts
 *
 * Orchestration lifecycle: terminal states, loop detection, finalization guard.
 *
 * Phases implemented:
 *  - Phase 1: Terminal state machine (PENDING → RUNNING → MERGED → COMPLETED | FAILED)
 *  - Phase 7: Merge finalization persists output + prevents reopen
 *  - Phase 8: Loop detector — block re-orchestration after 2 repeats
 */

import { redis } from '../redis';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type OrchestrationState =
  | 'PENDING'
  | 'RUNNING'
  | 'MERGED'
  | 'COMPLETED'
  | 'FAILED';

export interface OrchestrationRecord {
  parentId: string;
  userId: string;
  state: OrchestrationState;
  entryCount: number;   // how many times orchestration was entered (loop detection)
  finalOutput?: string;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

const KEY = (parentId: string) => `orch:state:${parentId}`;
const FINGERPRINT_KEY = (fp: string) => `orch:fp:${fp}`;
const TTL = 60 * 60 * 24; // 24h

// ---------------------------------------------------------------------------
// Terminal state check
// ---------------------------------------------------------------------------

export function isTerminalState(state: OrchestrationState): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'MERGED';
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createOrchestrationRecord(
  parentId: string,
  userId: string
): Promise<OrchestrationRecord> {
  const record: OrchestrationRecord = {
    parentId,
    userId,
    state: 'PENDING',
    entryCount: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await (redis as any).set(KEY(parentId), JSON.stringify(record), { ex: TTL });
  return record;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export async function getOrchestrationRecord(
  parentId: string
): Promise<OrchestrationRecord | null> {
  const raw = await (redis as any).get(KEY(parentId));
  if (!raw) return null;
  try { return JSON.parse(raw) as OrchestrationRecord; } catch { return null; }
}

// ---------------------------------------------------------------------------
// State transitions (safe — always persisted)
// ---------------------------------------------------------------------------

export async function transitionOrchestrationState(
  parentId: string,
  newState: OrchestrationState,
  extras: Partial<Pick<OrchestrationRecord, 'finalOutput' | 'completedAt'>> = {}
): Promise<void> {
  const record = await getOrchestrationRecord(parentId);
  if (!record) return;
  if (isTerminalState(record.state) && newState !== 'COMPLETED') {
    // Already terminal — ignore attempt to reopen
    console.info(
      `[orch-state] Ignored transition ${record.state} → ${newState} for ${parentId} (terminal)`
    );
    return;
  }
  const updated: OrchestrationRecord = {
    ...record,
    ...extras,
    state: newState,
    updatedAt: Date.now(),
    completedAt: newState === 'COMPLETED' || newState === 'FAILED' || newState === 'MERGED'
      ? Date.now()
      : record.completedAt,
  };
  await (redis as any).set(KEY(parentId), JSON.stringify(updated), { ex: TTL });
}

// ---------------------------------------------------------------------------
// Phase 7 — Merge finalization  
// ---------------------------------------------------------------------------

export async function finalizeMerge(
  parentId: string,
  finalOutput: string
): Promise<void> {
  await transitionOrchestrationState(parentId, 'MERGED', {
    finalOutput,
    completedAt: Date.now(),
  });
  // Transition MERGED → COMPLETED
  await transitionOrchestrationState(parentId, 'COMPLETED');
}

// ---------------------------------------------------------------------------
// Phase 8 — Loop detector
// ---------------------------------------------------------------------------

const MAX_LOOP_COUNT = 2;

/**
 * Atomically increments the entry count for a parent ID and returns whether
 * further orchestration is allowed.
 *
 * Allows up to MAX_LOOP_COUNT=2 orchestration attempts; blocks after that.
 */
export async function checkAndIncrementLoopCount(
  parentId: string
): Promise<{ allowed: boolean; entryCount: number }> {
  const record = await getOrchestrationRecord(parentId);
  if (!record) {
    // First time — will be created by prepareOrchestration
    return { allowed: true, entryCount: 1 };
  }
  if (isTerminalState(record.state)) {
    console.warn(`[orch-loop] Blocked re-entry into terminal orchestration ${parentId}`);
    return { allowed: false, entryCount: record.entryCount };
  }
  if (record.entryCount >= MAX_LOOP_COUNT) {
    console.warn(`[orch-loop] Loop threshold (${MAX_LOOP_COUNT}) reached for ${parentId} — forcing COMPLETED`);
    await transitionOrchestrationState(parentId, 'COMPLETED');
    return { allowed: false, entryCount: record.entryCount };
  }
  // Increment entry count
  const updated: OrchestrationRecord = {
    ...record,
    entryCount: record.entryCount + 1,
    updatedAt: Date.now(),
  };
  await (redis as any).set(KEY(parentId), JSON.stringify(updated), { ex: TTL });
  return { allowed: true, entryCount: updated.entryCount };
}

// ---------------------------------------------------------------------------
// Phase 2 — Request fingerprint for deduplication (used by orchestrator-lock)
// ---------------------------------------------------------------------------

export async function setFingerprintParent(
  fingerprint: string,
  parentId: string
): Promise<void> {
  await (redis as any).set(FINGERPRINT_KEY(fingerprint), parentId, { ex: 300 }); // 5-min TTL
}

export async function getFingerprintParent(
  fingerprint: string
): Promise<string | null> {
  return (redis as any).get(FINGERPRINT_KEY(fingerprint));
}
