/**
 * lib/recovery/overload-recovery.ts
 *
 * Central overload recovery pipeline.
 *
 * When a Gemini model returns overloaded_error / 503 / resource_exhausted:
 *   1. Classify the error as recoverable
 *   2. Compact context to reduce token pressure
 *   3. Rotate to a non-overloaded API key
 *   4. Fallback to next model in priority chain
 *   5. Retry with exponential backoff
 *
 * This module is called from both retry-engine.ts (gateway-level) and
 * subagent-executor.ts (subagent-level).
 */

import { getHealthiestKeyObj, reportKeyFailure } from '../key-manager';
import { redis } from '../redis';
import { countTokens } from '../tokenizer';

// ---------------------------------------------------------------------------
// Phase 1: Overload classifier
// ---------------------------------------------------------------------------

export function isOverloadError(errorOrMessage: string | { status?: number; message?: string }): boolean {
  const msg = typeof errorOrMessage === 'string'
    ? errorOrMessage.toLowerCase()
    : ((errorOrMessage.message ?? '') + ' ' + (errorOrMessage.status ?? '')).toLowerCase();
  return (
    msg.includes('529') ||
    msg.includes('overloaded') ||
    msg.includes('overload_error') ||
    msg.includes('capacity_error') ||
    msg.includes('resource_exhausted') ||
    msg.includes('503') ||
    msg.includes('rate limit') ||
    msg.includes('quota exceeded') ||
    msg.includes('capacity') ||
    msg.includes('too many requests')
  );
}

export function isRecoverableError(errorOrMessage: string | { status?: number; message?: string }): boolean {
  if (isOverloadError(errorOrMessage)) return true;
  const status = typeof errorOrMessage === 'object' ? errorOrMessage.status : undefined;
  return status === 429 || status === 529 || status === 503 || status === 502 || status === 500;
}

// ---------------------------------------------------------------------------
// Phase 5: Model fallback priority chain
// ---------------------------------------------------------------------------

const OVERLOAD_FALLBACK_CHAIN: string[] = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-flash-latest',
  // Gemma models run on separate infrastructure and are available when all
  // Gemini endpoints are simultaneously overloaded. Last-resort only since
  // they lack multi-modal capabilities.
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
];

/** Total number of distinct models in the recovery fallback chain. */
export const RECOVERY_CHAIN_SIZE = OVERLOAD_FALLBACK_CHAIN.length;

/**
 * Returns the next model in the priority chain that hasn't been tried.
 * Returns null when all models are exhausted.
 */
export function getNextFallbackModel(
  currentModel: string,
  triedModels: Set<string>
): string | null {
  for (const model of OVERLOAD_FALLBACK_CHAIN) {
    if (model !== currentModel && !triedModels.has(model)) {
      return model;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 4: Key rotation with overload cooldown
// ---------------------------------------------------------------------------

const KEY_OVERLOAD_COOLDOWN_KEY = (keyId: string) => `key:overload:cooldown:${keyId}`;
const KEY_OVERLOAD_COOLDOWN_SECS = 10; // 10s cooldown (was 30s — too aggressive with few keys)

/**
 * Mark a key as overloaded — puts it on cooldown so getHealthiestKeyObj
 * won't return it immediately.
 */
export async function cooldownOverloadedKey(keyId: string): Promise<void> {
  await reportKeyFailure(keyId, 'server');
  await (redis as any).set(KEY_OVERLOAD_COOLDOWN_KEY(keyId), 'overload', { ex: KEY_OVERLOAD_COOLDOWN_SECS });
  logRecovery('key-cooldown', { keyId, cooldownSecs: KEY_OVERLOAD_COOLDOWN_SECS });
}

/**
 * Get a fresh key, preferring one that isn't on overload cooldown.
 */
export async function rotateToFreshKey(
  userId?: string,
  excludeKeyId?: string
): Promise<{ id: string; key: string } | null> {
  // Try up to 3 keys to find one not on cooldown
  for (let i = 0; i < 3; i++) {
    const keyObj = await getHealthiestKeyObj(userId);
    if (!keyObj) return null;
    if (keyObj.id === excludeKeyId) continue; // skip the overloaded key
    const cooldown = await (redis as any).get(KEY_OVERLOAD_COOLDOWN_KEY(keyObj.id));
    if (!cooldown) return keyObj; // not on cooldown
  }
  // All keys on cooldown — return whatever we can get
  return getHealthiestKeyObj(userId);
}

// ---------------------------------------------------------------------------
// Phase 7: Token pressure detector
// ---------------------------------------------------------------------------

const HIGH_PRESSURE_THRESHOLD = 900_000; // ~900k chars → ~225k tokens

/**
 * Estimate token pressure from the request body.
 * Returns true if proactive compaction should be triggered.
 */
export function detectTokenPressure(body: any): { high: boolean; estimatedTokens: number } {
  let totalChars = 0;
  if (typeof body?.system === 'string') totalChars += body.system.length;
  if (Array.isArray(body?.contents)) {
    for (const c of body.contents) {
      if (Array.isArray(c?.parts)) {
        for (const p of c.parts) {
          if (typeof p?.text === 'string') totalChars += p.text.length;
        }
      }
    }
  }
  // Also check messages (Anthropic format)
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (typeof m?.content === 'string') totalChars += m.content.length;
      if (Array.isArray(m?.content)) {
        for (const block of m.content) {
          if (typeof block?.text === 'string') totalChars += block.text.length;
        }
      }
    }
  }
  const estimatedTokens = countTokens('x'.repeat(Math.min(totalChars, 1_000_000)));
  return { high: totalChars > HIGH_PRESSURE_THRESHOLD, estimatedTokens };
}

// ---------------------------------------------------------------------------
// Phase 3: Context compaction helper
// ---------------------------------------------------------------------------

/**
 * Compact the request body contents by trimming old tool outputs and 
 * completed subtask logs. Returns a new body with reduced content.
 * 
 * This is a fast, synchronous compaction (no model call) for emergency
 * overload recovery. For deeper AI compaction, use the ai-compactor.
 */
export function compactBodyForOverload(body: any): any {
  if (!body || !Array.isArray(body.contents)) return body;

  const contents = body.contents;
  if (contents.length <= 4) return body; // too short to compact

  // Keep the original opening prompt verbatim and preserve the active tail.
  // Under overload we aggressively drop the middle 60%+ of turns so the next
  // retry has a materially smaller payload while still retaining the current task.
  const headCount = 1;
  const tailCount = Math.min(Math.max(Math.ceil(contents.length * 0.3), 4), 8);
  const keptCount = Math.min(contents.length, headCount + tailCount);
  const removedCount = contents.length - keptCount;
  if (removedCount <= 0) return body;

  const head = contents.slice(0, headCount);
  const tail = contents.slice(contents.length - tailCount);
  const compactedMiddle = [{
    role: 'user',
    parts: [{
      text: `[${removedCount} earlier messages compacted for overload recovery. ` +
            `The original opening prompt is preserved verbatim and the newest active turns are kept intact.]`,
    }],
  }];

  logRecovery('compaction', {
    originalMessages: contents.length,
    compactedMessages: head.length + compactedMiddle.length + tail.length,
    removedMessages: removedCount,
  });

  return {
    ...body,
    contents: [...head, ...compactedMiddle, ...tail],
  };
}

// ---------------------------------------------------------------------------
// Phase 8: Exponential backoff calculator
// ---------------------------------------------------------------------------

/**
 * Compute overload-specific backoff with true exponential growth.
 * Stays fast for the first 3 attempts (model rotation is the primary recovery
 * strategy) then grows to give genuinely-overloaded systems time to recover.
 *
 * attempt 1 → ~200ms   (may be transient; rotate fast)
 * attempt 2 → ~500ms
 * attempt 3 → ~1200ms
 * attempt 4 → ~2500ms  (all primary models exhausted; wait before Gemma fallback)
 * attempt 5+ → ~4000ms (sustained overload; maximise gap between attempts)
 */
export function computeOverloadBackoff(attempt: number): number {
  const bases = [150, 400, 1000, 2200, 3700];
  const base = bases[Math.min(attempt - 1, bases.length - 1)] ?? 3700;
  const jitter = Math.floor(Math.random() * 300);
  return base + jitter;
}

/**
 * One-time delay before giving up when every model in the chain is overloaded.
 * Gives the system 2 s to shed load before returning a 529 to the client.
 */
export async function waitBeforeAllModelsExhausted(): Promise<void> {
  const delay = 2000 + Math.floor(Math.random() * 500);
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

// ---------------------------------------------------------------------------
// Phase 9: Stream state preservation
// ---------------------------------------------------------------------------

export interface PartialStreamState {
  model: string;
  keyId: string;
  chunksReceived: number;
  lastChunkText: string;
  bodySnapshot: any;
}

/**
 * Save partial stream state so it can be resumed after overload recovery.
 */
export async function savePartialStreamState(
  requestId: string,
  state: PartialStreamState
): Promise<void> {
  await (redis as any).set(
    `stream:partial:${requestId}`,
    JSON.stringify(state),
    { ex: 300 } // 5-min TTL
  );
}

export async function getPartialStreamState(
  requestId: string
): Promise<PartialStreamState | null> {
  const raw = await (redis as any).get(`stream:partial:${requestId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Phase 2: Full recovery pipeline
// ---------------------------------------------------------------------------

export interface OverloadRecoveryResult {
  recovered: boolean;
  newModel: string | null;
  newKeyId: string | null;
  compacted: boolean;
  backoffMs: number;
  attempt: number;
}

/**
 * Execute the full overload recovery pipeline.
 *
 * Steps (order matters):
 *   1. Compact context (reduce token pressure)
 *   2. Rotate to fresh API key
 *   3. Select fallback model
 *   4. Compute backoff delay
 *
 * Returns recovery instructions. Caller is responsible for the actual retry.
 */
export async function recoverFromOverload(opts: {
  currentModel: string;
  currentKeyId: string;
  triedModels: Set<string>;
  attempt: number;
  body: any;
  userId?: string;
}): Promise<OverloadRecoveryResult> {
  const { currentModel, currentKeyId, triedModels, attempt, body, userId } = opts;

  logRecovery('overload-detected', {
    model: currentModel,
    keyId: currentKeyId,
    attempt,
    triedModels: [...triedModels],
  });

  // Step 1: Cooldown the overloaded key (skip if already cooled)
  const alreadyCooled = await (redis as any).get(KEY_OVERLOAD_COOLDOWN_KEY(currentKeyId)).catch(() => null);
  if (!alreadyCooled) {
    await cooldownOverloadedKey(currentKeyId);
  }

  // Step 2: Detect if compaction would help
  const pressure = detectTokenPressure(body);
  let compacted = false;
  if (pressure.high) {
    logRecovery('compaction-triggered', { estimatedTokens: pressure.estimatedTokens });
    compacted = true;
  }

  // Step 3: Rotate to fresh key
  const freshKey = await rotateToFreshKey(userId, currentKeyId);
  const newKeyId = freshKey?.id ?? null;
  logRecovery('key-rotated', { oldKey: currentKeyId, newKey: newKeyId });

  // Step 4: Fallback model
  triedModels.add(currentModel);
  const newModel = getNextFallbackModel(currentModel, triedModels);
  if (newModel) {
    logRecovery('fallback-model-selected', { from: currentModel, to: newModel });
  }

  // Step 5: Compute backoff
  const backoffMs = computeOverloadBackoff(attempt);

  return {
    recovered: !!(newKeyId || newModel),
    newModel,
    newKeyId,
    compacted,
    backoffMs,
    attempt,
  };
}

// ---------------------------------------------------------------------------
// Phase 10: Logging
// ---------------------------------------------------------------------------

type RecoveryEvent =
  | 'overload-detected'
  | 'compaction-triggered'
  | 'compaction'
  | 'key-cooldown'
  | 'key-rotated'
  | 'fallback-model-selected'
  | 'subagent-resumed'
  | 'recovery-complete'
  | 'recovery-failed';

function logRecovery(event: RecoveryEvent, data: Record<string, unknown>): void {
  console.info(`[overload-recovery] event=${event}`, JSON.stringify(data));
}
