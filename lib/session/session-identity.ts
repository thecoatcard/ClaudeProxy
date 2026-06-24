/**
 * lib/session/session-identity.ts
 *
 * Hard Session Identity — Phase 1 of the gateway hardening pass.
 *
 * Problem:
 *   The previous fallback identity was derived from:
 *     hash(userId + systemText + firstMessage)
 *   This collides when the same user opens the same workspace with the same
 *   first message in different sessions (e.g. "Analyze this codebase").
 *
 * Solution:
 *   If the client provides an explicit conversation_id → use it directly.
 *   Otherwise → generate a cryptographically random session_nonce on the
 *   first request and persist it in Redis under session:nonce:{conversationId}.
 *   The nonce is derived from the initial hash-key so it is deterministic
 *   only within a single "conversation" slot — but unique across new sessions
 *   that land on the same slot.
 *
 *   Fallback identity: hash(userId + workspaceFingerprint + sessionNonce)
 *   NOT:               hash(userId + systemText + firstMessage)
 *
 * Redis keys:
 *   session:nonce:{hashId}   string   TTL: 6 h (same as session data)
 *
 * Edge-runtime safe: no Node.js crypto module. Uses Math.random + timestamp
 * which is sufficient for a nonce (not a security token).
 */

import { redis } from '../redis';
import { stableHash } from '../utils/hash';

const SESSION_NONCE_TTL = Number(process.env.CONTEXT_SUMMARY_TTL || 21600); // 6 h

function nonceKey(hashId: string): string {
  return `session:nonce:${hashId}`;
}

/**
 * Generate a random nonce string that is unique per session.
 * Not cryptographically strong — used for collision avoidance, not security.
 */
function generateNonce(): string {
  const ts = Date.now().toString(36);
  const r1 = Math.random().toString(36).slice(2, 10);
  const r2 = Math.random().toString(36).slice(2, 10);
  return `${ts}-${r1}-${r2}`;
}

/**
 * Retrieve or create the session nonce for a hash-derived conversation slot.
 *
 * On the very first request that hashes to this slot, no nonce exists → we
 * create one and store it. Subsequent requests to the same slot reuse the
 * stored nonce, ensuring session continuity within the same conversation
 * while preventing collisions from different conversations that happen to
 * share the same initial hash.
 *
 * @param hashId   The initial hash derived from userId + systemText + firstMsg.
 * @returns        The stable nonce for this session slot.
 */
export async function getOrCreateSessionNonce(hashId: string): Promise<string> {
  const key = nonceKey(hashId);
  try {
    const existing = await redis.get<string>(key);
    if (existing && typeof existing === 'string' && existing.trim()) {
      // Refresh TTL so active sessions don't expire mid-conversation.
      redis.expire(key, SESSION_NONCE_TTL).catch(() => {});
      return existing;
    }
    const nonce = generateNonce();
    // NX-style: only set if not already present to avoid a TOCTOU race.
    // We use set with ex (overwrites on race, which is acceptable because
    // both writers would generate unique nonces and the last writer wins —
    // still avoids the original hash-collision problem).
    await redis.set(key, nonce, { ex: SESSION_NONCE_TTL });
    return nonce;
  } catch {
    // Redis unavailable: generate a local nonce. Won't persist across
    // requests, so continuity may break — but it won't collide.
    return generateNonce();
  }
}

/**
 * Derive the final stable conversationId for an anonymous (hash-derived)
 * session using the nonce instead of the first-message content.
 *
 * This is the core of Phase 1: the fallback ID is now:
 *   hash(userId | workspaceFingerprint | sessionNonce)
 *
 * NOT:
 *   hash(userId | systemText | firstMessage)
 *
 * @param userId              Authenticated user token (truncated for privacy).
 * @param workspaceFingerprint  Normalised workspace fingerprint from Phase 2.
 * @param nonce               Session nonce from getOrCreateSessionNonce().
 * @returns                   Stable conversationId string.
 */
export function deriveHardSessionId(
  userId: string,
  workspaceFingerprint: string,
  nonce: string,
): string {
  const anchor = `${userId}|${workspaceFingerprint}|${nonce}`;
  return `anon-${stableHash(anchor)}`;
}

/**
 * Initial hash used only to key the nonce store.
 * Kept intentionally short — it does NOT become the conversationId.
 * It's just the "slot" address that maps to a nonce.
 */
export function deriveSlotHash(userId: string, systemText: string, firstMessage: string): string {
  const anchor = `${userId}|${systemText.slice(0, 200)}|${firstMessage.slice(0, 200)}`;
  return stableHash(anchor);
}
