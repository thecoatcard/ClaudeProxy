/**
 * lib/session/session-binding.ts
 *
 * Session Token Binding — Phase 4 of the gateway hardening pass.
 *
 * Binds a conversationId to a specific (userId, workspaceFingerprint, nonce)
 * tuple stored in Redis. Before hydration, the current request's identity
 * must match the stored binding. A mismatch denies hydration and protects
 * against cross-session, cross-workspace context leakage.
 *
 * Redis key: session:binding:{conversationId}
 * TTL: 6 h (same as session data)
 *
 * Binding is created on the first request that generates a new sessionId.
 * It is validated on every subsequent request for that sessionId.
 */

import { redis } from '../redis';
import { stableHash } from '../utils/hash';

const BINDING_TTL = Number(process.env.CONTEXT_SUMMARY_TTL || 21600); // 6 h

function bindingKey(conversationId: string): string {
  return `session:binding:${conversationId}`;
}

export interface SessionBinding {
  /** Hashed userId (never store raw tokens in Redis). */
  userHash: string;
  /** Workspace fingerprint string (short hex from Phase 2). */
  workspaceFingerprint: string;
  /** Session nonce from Phase 1. */
  nonce: string;
  /** Unix ms timestamp of when the binding was created. */
  createdAt: number;
}

/**
 * Attempt to load an existing session binding for this conversationId.
 * Returns null if none exists or on Redis error.
 */
export async function loadSessionBinding(conversationId: string): Promise<SessionBinding | null> {
  try {
    const raw = await redis.get<string>(bindingKey(conversationId));
    if (!raw) return null;
    const parsed: SessionBinding = JSON.parse(raw);
    if (!parsed?.userHash || !parsed?.workspaceFingerprint) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a session binding.
 * If a binding already exists for this conversationId, this is a no-op
 * (first-writer wins to prevent race overwriting).
 *
 * This is a CRITICAL write — must await completion, not fire-and-forget.
 */
export async function saveSessionBinding(
  conversationId: string,
  userId: string,
  workspaceFingerprint: string,
  nonce: string,
): Promise<void> {
  const key = bindingKey(conversationId);
  const binding: SessionBinding = {
    userHash: stableHash(userId),  // never store raw key
    workspaceFingerprint,
    nonce,
    createdAt: Date.now(),
  };
  // Atomic NX: only write if key doesn't exist (first-writer wins).
  // This eliminates the TOCTOU race from the previous get-then-set pattern.
  try {
    const result = await redis.set(key, JSON.stringify(binding), { ex: BINDING_TTL, nx: true });
    if (result === null) {
      // Key already exists — just refresh TTL so active sessions don't expire.
      redis.expire(key, BINDING_TTL).catch(() => {});
    }
  } catch {
    // Best-effort — failure means no binding created, hydration will fall back
    // to the conservative null-workspace policy.
  }
}

/**
 * Validate the current request against the stored binding.
 *
 * Returns:
 *   'valid'    — binding matches current identity → hydration may proceed
 *   'mismatch' — binding exists but differs → deny hydration
 *   'new'      — no binding exists → first request for this conversationId
 *
 * Mismatch conditions:
 *   - userId hash is different (different user, same conversationId)
 *   - workspaceFingerprint differs (same user, different workspace)
 */
export function validateBinding(
  binding: SessionBinding | null,
  userId: string,
  workspaceFingerprint: string,
): 'valid' | 'mismatch' | 'new' {
  if (!binding) return 'new';

  const currentUserHash = stableHash(userId);
  if (currentUserHash !== binding.userHash) return 'mismatch';

  // Unknown workspace (00000000 fallback fingerprint from Phase 2) is treated
  // as a wildcard — don't deny hydration just because workspace is undetected.
  const UNKNOWN = '00000000';
  if (
    workspaceFingerprint !== UNKNOWN &&
    binding.workspaceFingerprint !== UNKNOWN &&
    workspaceFingerprint !== binding.workspaceFingerprint
  ) {
    return 'mismatch';
  }

  return 'valid';
}

/**
 * Delete the session binding (called when a session is explicitly cleared).
 */
export async function deleteSessionBinding(conversationId: string): Promise<void> {
  await redis.del(bindingKey(conversationId)).catch(() => {});
}
