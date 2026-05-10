// Tool failure memory — Redis-backed tracking of repeated tool failures.
//
// Tracks failures per (sessionKey, toolName, filePath) tuple. Used by the
// behavior auditor to suppress guidance escalation when the model has already
// been given recovery steps, and to detect repeated identical attempts.
//
// Redis key: tool:fail:{sessionKey}:{sig}  (TTL 3600s)
// sig = stableHash("${toolName}:${filePath ?? '__no_file__'}")
//
// Noncritical: all Redis errors are swallowed. Never blocks the request path.

import { redis } from '../redis';
import { stableHash } from '../utils/hash';

export interface ToolFailureRecord {
  count: number;
  lastReason: string;
  toolName: string;
  filePath: string | null;
  updatedAt: number;
}

export interface FileSnapshotRecord {
  filePath: string;
  contentHash: string;
  size: number;
  updatedAt: number;
}

const TTL_SECS = 3600;

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function makeSnapshotKey(sessionKey: string, filePath: string): string {
  const sig = stableHash(`snapshot:${filePath}`);
  return `tool:snapshot:${sessionKey}:${sig}`;
}

function hashSnapshot(content: string): string {
  return stableHash(normalizeContent(content));
}

function makeKey(sessionKey: string, toolName: string, filePath: string | null): string {
  const sig = stableHash(`${toolName}:${filePath ?? '__no_file__'}`);
  return `tool:fail:${sessionKey}:${sig}`;
}

/**
 * Record a tool failure. Increments the count and updates lastReason.
 * Noncritical — swallows Redis errors.
 */
export async function recordToolFailure(
  sessionKey: string,
  toolName: string,
  filePath: string | null,
  reason: string,
): Promise<void> {
  try {
    const key = makeKey(sessionKey, toolName, filePath);
    const existing = await redis.get(key);
    const record: ToolFailureRecord = existing
      ? (JSON.parse(existing) as ToolFailureRecord)
      : { count: 0, lastReason: '', toolName, filePath, updatedAt: 0 };
    record.count++;
    record.lastReason = reason.slice(0, 200);
    record.updatedAt = Date.now();
    await redis.set(key, JSON.stringify(record), { ex: TTL_SECS });
  } catch {
    // noncritical
  }
}

/**
 * Returns the number of recorded failures for (sessionKey, toolName, filePath).
 * Returns 0 on Redis error.
 */
export async function getToolFailureCount(
  sessionKey: string,
  toolName: string,
  filePath: string | null,
): Promise<number> {
  try {
    const key = makeKey(sessionKey, toolName, filePath);
    const raw = await redis.get(key);
    if (!raw) return 0;
    return (JSON.parse(raw) as ToolFailureRecord).count;
  } catch {
    return 0;
  }
}

/**
 * Returns the full failure record, or null if not found / Redis error.
 */
export async function getToolFailureRecord(
  sessionKey: string,
  toolName: string,
  filePath: string | null,
): Promise<ToolFailureRecord | null> {
  try {
    const key = makeKey(sessionKey, toolName, filePath);
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as ToolFailureRecord;
  } catch {
    return null;
  }
}

/**
 * Returns true if the exact same (toolName, filePath, reason) was already
 * recorded — i.e. the model is about to repeat an identical failing attempt.
 */
export async function hasIdenticalRecentFailure(
  sessionKey: string,
  toolName: string,
  filePath: string | null,
  reason: string,
): Promise<boolean> {
  try {
    const key = makeKey(sessionKey, toolName, filePath);
    const raw = await redis.get(key);
    if (!raw) return false;
    const record = JSON.parse(raw) as ToolFailureRecord;
    return record.count >= 1 && record.lastReason === reason.slice(0, 200);
  } catch {
    return false;
  }
}

/**
 * Clear failure record (e.g. after a successful tool call).
 * Noncritical — swallows Redis errors.
 */
export async function clearToolFailures(
  sessionKey: string,
  toolName: string,
  filePath: string | null,
): Promise<void> {
  try {
    const key = makeKey(sessionKey, toolName, filePath);
    await redis.del(key);
  } catch {
    // noncritical
  }
}

/**
 * Record a fresh file snapshot hash after a successful read/view tool call.
 */
export async function recordFileSnapshot(
  sessionKey: string,
  filePath: string,
  content: string,
): Promise<FileSnapshotRecord | null> {
  try {
    const normalizedPath = filePath.trim();
    const normalizedContent = normalizeContent(content);
    const record: FileSnapshotRecord = {
      filePath: normalizedPath,
      contentHash: hashSnapshot(normalizedContent),
      size: normalizedContent.length,
      updatedAt: Date.now(),
    };
    await redis.set(makeSnapshotKey(sessionKey, normalizedPath), JSON.stringify(record), { ex: TTL_SECS });
    return record;
  } catch {
    return null;
  }
}

/**
 * Get the latest recorded snapshot hash for a file.
 */
export async function getFileSnapshot(
  sessionKey: string,
  filePath: string,
): Promise<FileSnapshotRecord | null> {
  try {
    const raw = await redis.get(makeSnapshotKey(sessionKey, filePath.trim()));
    if (!raw) return null;
    return JSON.parse(raw) as FileSnapshotRecord;
  } catch {
    return null;
  }
}

/**
 * A snapshot is fresh when it exists and is not older than maxAgeMs.
 */
export async function isSnapshotFresh(
  sessionKey: string,
  filePath: string,
  maxAgeMs = 120_000,
): Promise<boolean> {
  const snap = await getFileSnapshot(sessionKey, filePath);
  if (!snap) return false;
  return Date.now() - snap.updatedAt <= maxAgeMs;
}
