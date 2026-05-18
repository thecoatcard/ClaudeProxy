import { getHealthiestKeyObj, reportKeyFailure, recordKeyUsage } from './key-manager';
import { buildStickyRouteKey, getModelMapping } from './model-router';
import type { ModelRoute } from './model-router';
import { callGemini } from './gemini-adapter';
import { redis } from './redis';
import {
  splitForCache,
  prefixHash,
  lookupCache,
  saveCache,
  deleteCache,
  createCachedContent,
  isCacheSupported,
} from './cache-manager';
import {
  isOverloadError as classifyOverload,
  isRecoverableError,
  recoverFromOverload,
  recordModelHealth,
  compactBodyForOverload,
  detectTokenPressure,
  computeOverloadBackoff,
  waitBeforeAllModelsExhausted,
  RECOVERY_CHAIN_SIZE,
} from './recovery/overload-recovery';
import { logInfo, logWarn, logError } from './logging/event-logger';
import { errorOneLiner } from './logging/error-summarizer';
import { raceKeys, getDynamicKeyCount } from './racing/key-racer';
import { raceModels, getDynamicModelRaceConfig } from './racing/model-racer';
import { startTimer } from './metrics/performance-tracker';
import { withTimeout, MODEL_CALL_TIMEOUT, REQUEST_TIMEOUT } from './runtime/response-watchdog';
import {
  performEmergencyCompaction,
  type EmergencyCompactionRequestContext,
} from './context/emergency-compactor';
import { getAdminSystemSettings } from './admin-settings';

// Models that can't see images. We strip inlineData/fileData parts before
// sending to avoid a round-trip 400.
const TEXT_ONLY_MODELS = new Set<string>([
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
]);

function isTextOnly(internalModel: string): boolean {
  if (TEXT_ONLY_MODELS.has(internalModel)) return true;
  if (internalModel.startsWith('gemma')) return true;
  return false;
}

function stripImagesFromBody(body: any): any {
  if (!body || !Array.isArray(body.contents)) return body;
  return {
    ...body,
    contents: body.contents.map((c: any) => ({
      ...c,
      parts: Array.isArray(c.parts)
        ? c.parts
            .filter((p: any) => !p?.inlineData && !p?.fileData)
            .map((p: any) =>
              // Replace any pure-image turns with a placeholder so we don't end up
              // with empty parts arrays (Gemini rejects those).
              p
            )
        : c.parts,
    })).map((c: any) => {
      if (Array.isArray(c.parts) && c.parts.length === 0) {
        return { ...c, parts: [{ text: '[image omitted — not supported by this model]' }] };
      }
      return c;
    }),
  };
}

export function stripThoughtSignatures(body: any, removeFunctionCallSignatures = false): any {
  if (!body || !Array.isArray(body.contents)) return body;
  return {
    ...body,
    contents: body.contents.map((c: any) => ({
      ...c,
      parts: Array.isArray(c.parts)
        ? c.parts.map((p: any) => {
            if (p && 'thoughtSignature' in p && (removeFunctionCallSignatures || !p.functionCall)) {
              const { thoughtSignature, ...rest } = p;
              return rest;
            }
            return p;
          })
        : c.parts,
    })),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(attempt: number): number {
  const base = Math.min(1500, 120 * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 120);
  return base + jitter;
}

/**
 * Phase 7 — Dynamic Key Race Timeout.
 *
 * The race timeout is adaptive per task type. Cheap tasks (CHAT) race faster
 * to minimise user-facing latency. Expensive tasks (HEAVY_CODING, REASONING)
 * allow more time so slower-but-accurate keys can catch up before we fall back.
 *
 * Values chosen based on observed P95 cold-start latencies per task type:
 *   CHAT           → 2000ms  (fast response expected; give up quickly)
 *   LIGHT_CODING   → 3500ms  (default: moderate latency)
 *   HEAVY_CODING   → 5000ms  (complex tasks take longer; worth waiting)
 *   REASONING      → 6000ms  (Gemma reasoning tasks need extra time)
 *   OVERLOAD       → 3000ms  (recovery path: don't add too much extra wait)
 *   default        → 3500ms
 */
function getFastPathRaceTimeoutMs(taskType?: string): number {
  const envOverride = Number(process.env.FAST_PATH_RACE_TIMEOUT);
  if (envOverride > 0) {
    return Math.max(1000, Math.min(envOverride, MODEL_CALL_TIMEOUT));
  }
  const timeoutByTask: Record<string, number> = {
    CHAT:          2000,
    HEALTH_CHECK:  2000,
    LIGHT_CODING:  3500,
    WEB_SEARCH:    3500,
    COMPACTION:    3500,
    HEAVY_CODING:  5000,
    REASONING:     6000,
    OVERLOAD:      3000,
  };
  const ms = timeoutByTask[taskType ?? 'LIGHT_CODING'] ?? 3500;
  return Math.max(1000, Math.min(ms, MODEL_CALL_TIMEOUT));
}

function getAttemptModelCallTimeoutMs(taskType: string | undefined, attempt: number): number {
  const normalizedTask = taskType ?? 'LIGHT_CODING';
  if (normalizedTask === 'CHAT' || normalizedTask === 'HEALTH_CHECK') {
    return Math.min(MODEL_CALL_TIMEOUT, 8_000);
  }
  if (attempt > 1) {
    return Math.min(MODEL_CALL_TIMEOUT, 10_000);
  }
  return MODEL_CALL_TIMEOUT;
}

async function rememberLastWorkingModel(
  userId: string | undefined,
  anthropicModel: string,
  internalModel: string,
  routeVersion?: string,
) {
  if (!userId) return;
  try {
    const stickyKey = buildStickyRouteKey(userId, anthropicModel, routeVersion ?? '0');
    await redis.set(stickyKey, internalModel, { ex: 3600 }); // 60 min — covers full agentic session
  } catch {
    // Best-effort only.
  }
}

async function forgetLastWorkingModel(
  userId: string | undefined,
  anthropicModel: string,
  routeVersion?: string,
) {
  if (!userId) return;
  try {
    const stickyKey = buildStickyRouteKey(userId, anthropicModel, routeVersion ?? '0');
    await redis.del(stickyKey);
  } catch {
    // Best-effort only.
  }
}

/**
 * Replace the body's prefix with a cachedContent reference when we have a hit.
 * Falls back to creating a new cache on miss. Returns the body to send, or the
 * original body if caching isn't beneficial.
 */
// Returns { body: transformed body, hash: cache key used } so the caller can
// store the hash for later invalidation without recomputing it.
async function applyCache(
  internalModel: string,
  keyId: string,
  apiKey: string,
  body: any
): Promise<{ body: any; hash: string | null }> {
  if (!isCacheSupported(internalModel)) return { body, hash: null };

  const split = splitForCache(body);
  if (!split) return { body, hash: null };

  // Strip signatures from the prefix before hashing/caching — sigs are keyed
  // to a specific response and would pollute the hash.
  const cleanPrefix = stripThoughtSignatures(split.prefix);
  const hash = await prefixHash(internalModel, keyId, cleanPrefix);

  let cacheName = await lookupCache(hash);

  if (!cacheName) {
    cacheName = await createCachedContent(internalModel, apiKey, cleanPrefix);
    if (cacheName) {
      await saveCache(hash, cacheName);
    } else {
      return { body, hash };
    }
  }

  // Preserve all original top-level fields (toolConfig, safetySettings, etc.)
  // except the ones now baked into the cache (tools, systemInstruction) and
  // the contents array (replaced with the live tail).
  // Also strip sigs from the tail for consistency with the cache — Gemini
  // rejects signatures that reference a prefix it can't validate.
  const { tools, systemInstruction, contents, ...rest } = body;
  const cleanTail = stripThoughtSignatures({ contents: split.tail }).contents;

  return {
    body: {
      ...rest,
      contents: cleanTail,
      cachedContent: cacheName,
    },
    hash,
  };
}

export async function executeWithRetry(
  anthropicModel: string,
  geminiBody: any,
  stream: boolean,
  userId?: string,
  routePlan?: ModelRoute,
  requestId?: string,
  requestContext?: EmergencyCompactionRequestContext,
) {
  const isThinkingRequested = !!geminiBody.generationConfig?.thinkingConfig;
  const modelMap = routePlan || await getModelMapping(anthropicModel, { thinkingEnabled: isThinkingRequested, userId });
  const systemSettings = await getAdminSystemSettings();
  const fallbacks = Array.isArray(modelMap.fallback) ? modelMap.fallback : (modelMap.fallback ? [modelMap.fallback] : []);
  const configuredRetries = Number(process.env.MAX_RETRIES || 3);
  const maxRetries = Math.min(Math.max(configuredRetries, (fallbacks.length * 2) + 2), 12);

  const primaryModel = modelMap.primary;
  let currentInternalModel = primaryModel;
  let fallbackIndex = 0;
  let lastError;
  let stripSigs = false;
  let stripThinking = false;
  let skipCache = false;
  let lastCacheHash: string | null = null;
  // Tracks whether we already gave a free retry for a thought_signature 400.
  // Only the first occurrence of this config-level error is exempt from the
  // attempt counter — subsequent occurrences burn an attempt normally so we
  // never get stuck retrying the same model forever.
  let thinkingStrippedFreeRetryUsed = false;
  const clearStickyRoute = () => forgetLastWorkingModel(userId, anthropicModel, modelMap.routeVersion);
  // Tracks distinct models that returned 503 — when all chain models are
  // exhausted we break early instead of burning remaining retries on models
  // that are confirmed overloaded. This cuts worst-case latency from ~25s to ~8s.
  const overloadedModels = new Set<string>();
  let overloadEvents = 0;
  const MAX_OVERLOAD_EVENTS = Math.max(4, Math.min(RECOVERY_CHAIN_SIZE + 1, 8));
  // When Gemini returns 400 "max tokens exceeded", we reduce maxOutputTokens
  // for all subsequent attempts. Null = use the value already in geminiBody.
  let maxOutputTokensOverride: number | null = null;

  const maybeEmergencyCompact = async (reason: { status?: number; message?: string }, attempt: number) => {
    if (!classifyOverload(reason)) return false;
    logWarn('OVERLOAD', 'OVERLOAD_DETECTED', {
      requestId,
      metadata: {
        attempt,
        model: currentInternalModel,
        status: reason.status,
        message: reason.message,
      },
    });
    const compacted = await performEmergencyCompaction(geminiBody, {
      ...requestContext,
      requestId,
      userId,
    });
    if (!compacted.compacted) {
      return compacted.hardFallback;
    }
    geminiBody = compacted.body;
    skipCache = true;
    if (lastCacheHash) {
      await deleteCache(lastCacheHash).catch(() => {});
      lastCacheHash = null;
    }
    return true;
  };

  const requestTimer = startTimer();

  const initialPressure = detectTokenPressure(geminiBody);
  if (initialPressure.high) {
    logInfo('COMPACTION', `High token pressure before fast path (${initialPressure.estimatedTokens} est tokens) — shrinking middle turns before racing`);
    geminiBody = compactBodyForOverload(geminiBody);
  }

  // -----------------------------------------------------------------------
  // Phase 0: Parallel key racing — fire multiple keys simultaneously on
  // primary model. If one responds 2xx, return immediately (skips serial loop).
  // -----------------------------------------------------------------------
  const KEY_RACE_COUNT = getDynamicKeyCount(modelMap.taskType ?? 'LIGHT_CODING', false, systemSettings.racingEnabled);
  if (KEY_RACE_COUNT > 1) {
    const keyRaceTimer = startTimer();
    const keyRaceResult = await withTimeout(
      raceKeys({
        model: primaryModel,
        body: geminiBody,
        stream,
        keyCount: KEY_RACE_COUNT,
        userId,
      }),
      getFastPathRaceTimeoutMs(modelMap.taskType),
      'keyRace',
    ).catch(() => null);
    if (keyRaceResult?.response.ok) {
      await rememberLastWorkingModel(userId, anthropicModel, primaryModel, modelMap.routeVersion);
      logInfo('KEY_RACE', `Fast path: key race won on ${primaryModel} in ${keyRaceResult.latencyMs}ms`);
      logInfo('KEY_RACE', 'Key race completed', {
        requestId,
        duration: keyRaceResult.latencyMs,
        metadata: { model: primaryModel, racedKeys: keyRaceResult.racedKeys, winnerId: keyRaceResult.winnerId },
      });
      await keyRaceTimer.record('key_race_latency');
      await requestTimer.record('total_latency');
      return keyRaceResult.response;
    }
  } else {
    logInfo('KEY_RACE', 'Key race skipped', { requestId, duration: 0, metadata: { enabled: false } });
  }

  // -----------------------------------------------------------------------
  // Phase 0b: Parallel model racing — if key race failed/overloaded,
  // race fallback models simultaneously before falling back to serial loop.
  // -----------------------------------------------------------------------
  const modelRaceConfig = getDynamicModelRaceConfig(modelMap.taskType ?? 'LIGHT_CODING', false, systemSettings.racingEnabled);
  if (modelRaceConfig.enabled && fallbacks.length > 0) {
    const modelRaceTimer = startTimer();
    const modelRaceResult = await withTimeout(
      raceModels({
        models: [primaryModel, ...fallbacks.slice(0, modelRaceConfig.modelCount - 1)],
        body: geminiBody,
        stream,
        userId,
        bodyTransformer: (model, b) => {
          if (isTextOnly(model)) return stripImagesFromBody(b);
          return b;
        },
      }),
      getFastPathRaceTimeoutMs(modelMap.taskType),
      'modelRace',
    ).catch(() => null);
    if (modelRaceResult?.response.ok) {
      await rememberLastWorkingModel(userId, anthropicModel, modelRaceResult.model, modelMap.routeVersion);
      logInfo('MODEL_RACE', `Fast path: model race won on ${modelRaceResult.model} in ${modelRaceResult.latencyMs}ms`);
      logInfo('MODEL_RACE', 'Model race completed', {
        requestId,
        duration: modelRaceResult.latencyMs,
        metadata: { winnerModel: modelRaceResult.winnerModel, racedModels: modelRaceResult.racedModels },
      });
      await modelRaceTimer.record('model_race_latency');
      await requestTimer.record('total_latency');
      return modelRaceResult.response;
    }
  } else {
    logInfo('MODEL_RACE', 'Model race skipped', { requestId, duration: 0, metadata: { enabled: false } });
  }

  // -----------------------------------------------------------------------
  // Serial retry loop — fallback when racing doesn't produce a winner
  // -----------------------------------------------------------------------

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Hard budget check: if total elapsed time exceeds REQUEST_TIMEOUT, stop retrying
    if (requestTimer.elapsed() >= REQUEST_TIMEOUT) {
      logError('RETRY', `Request time budget exhausted (${requestTimer.elapsed()}ms) — failing after ${attempt - 1} attempt(s)`);
      break;
    }

    const keyObj = await getHealthiestKeyObj(userId);

    if (!keyObj) {
      // Phase 1: Classify as recoverable — attempt key rotation before throwing
      const recoveryResult = await recoverFromOverload({
        currentModel: currentInternalModel,
        currentKeyId: 'none',
        triedModels: overloadedModels,
        attempt,
        body: geminiBody,
        userId,
      });
      if (recoveryResult.recovered && recoveryResult.newKeyId) {
        logInfo('KEY_ROTATION', `Recovery rotated to key ${recoveryResult.newKeyId}`);
        await sleep(recoveryResult.backoffMs);
        continue;
      }
      throw new Error('overloaded_error'); // will be mapped to 529
    }

    // Phase 7: Proactive token pressure detection — compact before overload
    const pressure = detectTokenPressure(geminiBody);
    if (pressure.high && attempt === 1) {
      logInfo('COMPACTION', `High token pressure (${pressure.estimatedTokens} est tokens) — compacting proactively`);
      geminiBody = compactBodyForOverload(geminiBody);
    }

    // thoughtSignatures are only valid for the model that produced them.
    // If we fall back to a different model (or a previous 400 hinted at a
    // signature mismatch), strip them to avoid INVALID_ARGUMENT errors.
    const needsFullThoughtReset = currentInternalModel !== primaryModel || stripThinking;
    let bodyForThisAttempt = (currentInternalModel !== primaryModel || stripSigs || stripThinking)
      ? stripThoughtSignatures(geminiBody, needsFullThoughtReset)
      : geminiBody;

    // Thought state cannot survive a model switch. Reset it on any fallback model,
    // and also after a prior 400 that pointed to thinking/signature mismatch.
    if (needsFullThoughtReset && bodyForThisAttempt.generationConfig?.thinkingConfig) {
      const { thinkingConfig, ...restGenConfig } = bodyForThisAttempt.generationConfig;
      bodyForThisAttempt = {
        ...bodyForThisAttempt,
        generationConfig: restGenConfig
      };
    }

    // Fast-fail: strip images before sending to text-only models so we don't
    // pay a round-trip 400 just to discover the model can't read them.
    if (isTextOnly(currentInternalModel)) {
      bodyForThisAttempt = stripImagesFromBody(bodyForThisAttempt);
    }

    // Apply maxOutputTokens override if a previous attempt detected a token-limit 400.
    // This handles cases where our ceiling constant is higher than the model's true API limit.
    if (maxOutputTokensOverride !== null && bodyForThisAttempt.generationConfig) {
      bodyForThisAttempt = {
        ...bodyForThisAttempt,
        generationConfig: {
          ...bodyForThisAttempt.generationConfig,
          maxOutputTokens: maxOutputTokensOverride,
        },
      };
    }

    // Swap the prefix for a cachedContent reference when the payload is large.
    // skipCache is flipped after a cache-related 400 so the retry doesn't
    // rebuild the same broken reference on Google's side.
    if (!skipCache) {
      try {
        const cacheResult = await applyCache(
          currentInternalModel,
          keyObj.id,
          keyObj.key,
          bodyForThisAttempt
        );
        bodyForThisAttempt = cacheResult.body;
        // Reuse the hash applyCache already computed — no second SHA-256 needed.
        lastCacheHash = cacheResult.hash;
      } catch (e) {
        // Caching is a best-effort optimization — never fail the request over it.
        logWarn('RETRY', `Cache apply failed: ${errorOneLiner(e, 'cache')}`);
      }
    } else {
      lastCacheHash = null;
    }

    try {
      const modelCallStart = Date.now();
      const modelCallTimeoutMs = getAttemptModelCallTimeoutMs(modelMap.taskType, attempt);
      const modelCallController = new AbortController();
      const res = await withTimeout(
        callGemini(currentInternalModel, keyObj.key, bodyForThisAttempt, stream, {
          signal: modelCallController.signal,
          timeoutMs: modelCallTimeoutMs + 1000,
        }),
        modelCallTimeoutMs,
        `callGemini(${currentInternalModel})`,
        modelCallController,
      );
      logInfo('MODEL_CALL', 'Gemini model call completed', {
        requestId,
        duration: Date.now() - modelCallStart,
        metadata: { model: currentInternalModel, status: res.status, attempt, stream },
      });

      if (res.status === 403) {
        // Invalid or revoked key — mark as revoked and move to next key immediately
        await reportKeyFailure(keyObj.id, 'auth');
        lastError = { status: 403 };
        await sleep(computeBackoffMs(attempt));
        continue;
      }

      if (res.status === 429) {
        await reportKeyFailure(keyObj.id, 'ratelimit');
        lastError = { status: 429 };
        await sleep(computeBackoffMs(attempt));
        continue;
      }

      if (res.status === 503) {
        overloadedModels.add(currentInternalModel);
        if (fallbackIndex < fallbacks.length) {
          const prev = currentInternalModel;
          await clearStickyRoute();
          currentInternalModel = fallbacks[fallbackIndex++];
          logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
            requestId,
            metadata: { fromModel: prev, toModel: currentInternalModel, status: 503, attempt },
          });
        } else {
          logError('OVERLOAD', `No fallback model left after 503 on ${currentInternalModel}`);
          break;
        }
        lastError = { status: 503 };
        await sleep(computeOverloadBackoff(attempt));
        continue;
      }

      if (res.status >= 500) {
        await maybeEmergencyCompact({ status: res.status, message: 'capacity_error' }, attempt);

        const recovery = await recoverFromOverload({
          currentModel: currentInternalModel,
          currentKeyId: keyObj.id,
          triedModels: overloadedModels,
          attempt,
          body: geminiBody,
          userId,
        });

        overloadedModels.add(currentInternalModel);
        if (recovery.newModel) {
          logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
            requestId,
            metadata: { fromModel: currentInternalModel, toModel: recovery.newModel, status: res.status, attempt },
          });
          await clearStickyRoute();
          currentInternalModel = recovery.newModel;
          while (fallbackIndex < fallbacks.length && fallbacks[fallbackIndex] !== recovery.newModel) {
            fallbackIndex++;
          }
          if (fallbackIndex < fallbacks.length) fallbackIndex++;
        } else if (fallbackIndex < fallbacks.length) {
          const prev = currentInternalModel;
          await clearStickyRoute();
          currentInternalModel = fallbacks[fallbackIndex++];
          logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
            requestId,
            metadata: { fromModel: prev, toModel: currentInternalModel, status: res.status, attempt },
          });
        }

        const totalAvailableModels = Math.max(1 + fallbacks.length, RECOVERY_CHAIN_SIZE);
        if (overloadedModels.size >= totalAvailableModels) {
          logError('OVERLOAD', `All ${overloadedModels.size} models overloaded — waiting 2 s before failing`);
          await waitBeforeAllModelsExhausted();
          break;
        }

        lastError = { status: res.status };
        await sleep(computeOverloadBackoff(attempt));
        continue;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err?.error?.message || err?.message || '';

        // Handle 503 Service Unavailable or 500 Internal Server Error
        // Also handle transient 400 "unexpected error" as a server-side glitch
        const isTransientBackendErr = (res.status === 400 && /unexpected error|internal error/i.test(msg));
        
        if (res.status === 503) {
          overloadedModels.add(currentInternalModel);
          if (fallbackIndex < fallbacks.length) {
            const prev = currentInternalModel;
            await clearStickyRoute();
            currentInternalModel = fallbacks[fallbackIndex++];
            logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
              requestId,
              metadata: { fromModel: prev, toModel: currentInternalModel, status: 503, attempt },
            });
          } else {
            logError('OVERLOAD', `No fallback model left after 503 on ${currentInternalModel}`);
            break;
          }
          lastError = { status: 503, message: msg };
          await sleep(computeOverloadBackoff(attempt));
          continue;
        }

        if (res.status >= 500 || isTransientBackendErr) {
          await maybeEmergencyCompact({ status: res.status, message: msg || 'capacity_error' }, attempt);

          const recovery = await recoverFromOverload({
            currentModel: currentInternalModel,
            currentKeyId: keyObj.id,
            triedModels: overloadedModels,
            attempt,
            body: geminiBody,
            userId,
          });

          overloadedModels.add(currentInternalModel);
          if (recovery.newModel) {
            logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
              requestId,
              metadata: { fromModel: currentInternalModel, toModel: recovery.newModel, status: res.status, attempt },
            });
            await clearStickyRoute();
            currentInternalModel = recovery.newModel;
          } else if (fallbackIndex < fallbacks.length) {
            const prev = currentInternalModel;
            await clearStickyRoute();
            currentInternalModel = fallbacks[fallbackIndex++];
            logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
              requestId,
              metadata: { fromModel: prev, toModel: currentInternalModel, status: res.status, attempt },
            });
          }

          const totalAvailableModels2 = Math.max(1 + fallbacks.length, RECOVERY_CHAIN_SIZE);
          if (overloadedModels.size >= totalAvailableModels2) {
            logError('OVERLOAD', `All ${overloadedModels.size} models overloaded (body parse) — waiting 2 s before failing`);
            await waitBeforeAllModelsExhausted();
            break;
          }

          lastError = { status: res.status, message: msg };
          await sleep(computeOverloadBackoff(attempt));
          continue;
        }

        logError('RETRY', `Gemini API Error on ${currentInternalModel}`, {
          metadata: { error: err, model: currentInternalModel, stripSigs },
        });

        // Cache miss / expired / bad reference: drop the mapping, flip the
        // skip flag so the next attempt sends the full uncached body.
        const isCacheErr = res.status === 400 && /cached ?content|cache/i.test(msg);
        if (isCacheErr && lastCacheHash) {
          await deleteCache(lastCacheHash);
          lastCacheHash = null;
          skipCache = true;
          lastError = { status: 400 };
          await sleep(computeBackoffMs(attempt));
          continue;
        }

        // If we hit a 400, try degrading the request in sequence:
        // 1. "thought_signature" error — set BOTH stripSigs + stripThinking at once.
        //    Setting only stripSigs while keeping thinking active creates bare functionCalls
        //    which is exactly what Gemini just rejected. Never set one without the other.
        // 2. "max tokens exceeded" — reduce maxOutputTokens immediately (handled above)
        // 3. Strip thoughtSignatures from thought-text parts (common for model mismatches)
        //    Always strip thinking at the same time to avoid the invalid intermediate state.
        // 4. Strip thinkingConfig alone (budget/unsupported issues on non-thinking fallbacks)
        // 5. Move to fallback model
        //
        // IMPORTANT: 400 = request format error. Do NOT call reportKeyFailure — the key
        // is valid, our payload is wrong. Marking keys bad here depletes the pool and
        // causes a cascade into overloaded_error / 529.
        if (res.status === 400) {
          // Fast path: explicit thought_signature error — strip both flags at once.
          const isThoughtSigErr = /thought.?signature|missing.*signature/i.test(msg);
          if (isThoughtSigErr) {
            stripSigs    = true;
            stripThinking = true;
            logWarn('RETRY', `thought_signature 400 on ${currentInternalModel} — disabling thinking`);
            lastError = { status: 400, message: msg };
            // Don't charge an attempt for this config-level fix — the retry will
            // use the same model with thinking stripped. We only grant one free
            // retry per request so the engine can't spin on repeated 400s.
            if (!thinkingStrippedFreeRetryUsed) {
              thinkingStrippedFreeRetryUsed = true;
              attempt--; // the loop's attempt++ cancels this out — net: same attempt index
            }
            const remainingBudgetMs = REQUEST_TIMEOUT - requestTimer.elapsed();
            if (remainingBudgetMs > 3_000) await sleep(computeBackoffMs(attempt));
            continue;
          }

          // Max output tokens exceeded — extract model's actual limit and retry.
          const isTokenLimitErr = /max.?token|token.?limit|exceed.*token/i.test(msg);
          if (isTokenLimitErr) {
            const limitMatch = msg.match(/(\d{4,6})/);
            const modelActualLimit = limitMatch ? Number(limitMatch[1]) : 32000;
            maxOutputTokensOverride = Math.floor(modelActualLimit * 0.9);
            logWarn('RETRY', `Max token 400 on ${currentInternalModel}: limit=${modelActualLimit}, retrying with ${maxOutputTokensOverride}`);
            lastError = { status: 400, message: msg };
            await sleep(computeBackoffMs(attempt));
            continue;
          }

          const hasSigs    = JSON.stringify(bodyForThisAttempt).includes('thoughtSignature');
          const hasThinking = JSON.stringify(bodyForThisAttempt).includes('thinkingConfig');

          if (hasSigs && !stripSigs) {
            // Always pair stripSigs with stripThinking: a body without sigs but
            // WITH thinkingConfig still causes "missing thought_signature" on functionCalls.
            stripSigs    = true;
            stripThinking = true;
          } else if (hasThinking && !stripThinking) {
            stripThinking = true;
          } else if (fallbackIndex < fallbacks.length) {
            const prev = currentInternalModel;
            await clearStickyRoute();
            currentInternalModel = fallbacks[fallbackIndex++];
            logWarn('ROUTING', `Fallback: ${prev} → ${currentInternalModel} (bad_request_400)`);
          }

          lastError = { status: 400, message: msg };
          await sleep(computeBackoffMs(attempt));
          continue;
        }

        throw { status: res.status, data: err };
      }

      // Success
      await recordKeyUsage(keyObj.id);
      await rememberLastWorkingModel(userId, anthropicModel, currentInternalModel, modelMap.routeVersion);
      await requestTimer.record('total_latency');
      return res;
    } catch (err: any) {
      // Phase 1: Classify overload errors as recoverable — don't hard throw
      if (err.status === 429 && attempt < maxRetries) {
        await reportKeyFailure(keyObj.id, 'ratelimit');
        lastError = err;
        await sleep(computeBackoffMs(attempt));
        continue;
      }

      if (err.status === 503 && attempt < maxRetries) {
        overloadEvents++;
        overloadedModels.add(currentInternalModel);
        if (fallbackIndex < fallbacks.length) {
          const prev = currentInternalModel;
          await clearStickyRoute();
          currentInternalModel = fallbacks[fallbackIndex++];
          logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
            requestId,
            metadata: { fromModel: prev, toModel: currentInternalModel, status: 503, attempt },
          });
          lastError = err;
          // Skip long backoff when budget is low — give the new model a fair attempt
          const budgetRemaining503 = REQUEST_TIMEOUT - requestTimer.elapsed();
          const backoff503 = budgetRemaining503 < 10_000 ? 0 : computeOverloadBackoff(attempt);
          if (backoff503 > 0) await sleep(backoff503);
          if (overloadEvents >= MAX_OVERLOAD_EVENTS) {
            logError('OVERLOAD', `Overload circuit breaker tripped (${overloadEvents} events) — failing fast`);
            throw err;
          }
          continue;
        }
      }

      if (classifyOverload({ status: err.status, message: err.message }) && attempt < maxRetries) {
        overloadEvents++;
        // Track this model as overloaded so recovery doesn't return it again
        overloadedModels.add(currentInternalModel);
        await maybeEmergencyCompact({ status: err.status ?? 529, message: err.message ?? 'overloaded_error' }, attempt);
        const recovery = await recoverFromOverload({
          currentModel: currentInternalModel,
          currentKeyId: keyObj.id,
          triedModels: overloadedModels,
          attempt,
          body: geminiBody,
          userId,
        });
        if (recovery.recovered) {
          if (recovery.newModel) {
            logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
              requestId,
              metadata: { fromModel: currentInternalModel, toModel: recovery.newModel, status: err.status ?? 529, attempt },
            });
            await clearStickyRoute();
            currentInternalModel = recovery.newModel;
          }
          // Fast-exit: all available models exhausted
          if (overloadedModels.size >= Math.max(1 + fallbacks.length, RECOVERY_CHAIN_SIZE)) {
            logError('OVERLOAD', `All ${overloadedModels.size} models overloaded (stream) — failing fast after ${attempt} attempt(s)`);
            throw err;
          }
          lastError = err;
          // Skip long backoff when budget is critically low — give the fallback model a fair attempt
          const budgetRemainingOverload = REQUEST_TIMEOUT - requestTimer.elapsed();
          const backoffOverload = budgetRemainingOverload < 10_000 ? 0 : recovery.backoffMs;
          if (backoffOverload > 0) await sleep(backoffOverload);
          if (overloadEvents >= MAX_OVERLOAD_EVENTS) {
            logError('OVERLOAD', `Overload circuit breaker tripped (${overloadEvents} events) — failing fast`);
            throw err;
          }
          continue;
        }
        throw err; // recovery exhausted — rethrow
      }
      if (classifyOverload({ status: err.status, message: err.message })) throw err;
      
      // If it's a 400 (likely safety or bad request), try one more time with a fallback model
      if (err.status === 400 && fallbackIndex < fallbacks.length) {
        const prev = currentInternalModel;
        await clearStickyRoute();
        currentInternalModel = fallbacks[fallbackIndex++];
        logWarn('ROUTING', `Fallback: ${prev} → ${currentInternalModel} (exception_400)`);
        lastError = err;
        await sleep(computeBackoffMs(attempt));
        continue;
      }

      if (err.name === 'AbortError' || err.message?.includes('Timeout:')) {
        overloadEvents++;
        await reportKeyFailure(keyObj.id, 'server');
        overloadedModels.add(currentInternalModel);
        await maybeEmergencyCompact({ status: 504, message: err.message ?? 'capacity_error timeout' }, attempt);

        const recovery = await recoverFromOverload({
          currentModel: currentInternalModel,
          currentKeyId: keyObj.id,
          triedModels: overloadedModels,
          attempt,
          body: geminiBody,
          userId,
        });

        if (recovery.newModel) {
          logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
            requestId,
            metadata: { fromModel: currentInternalModel, toModel: recovery.newModel, status: 504, attempt },
          });
          currentInternalModel = recovery.newModel;
          while (fallbackIndex < fallbacks.length && fallbacks[fallbackIndex] !== recovery.newModel) {
            fallbackIndex++;
          }
          if (fallbackIndex < fallbacks.length) fallbackIndex++;
        } else if (fallbackIndex < fallbacks.length) {
          const prev = currentInternalModel;
          currentInternalModel = fallbacks[fallbackIndex++];
          logWarn('OVERLOAD', 'FALLBACK_MODEL_SELECTED', {
            requestId,
            metadata: { fromModel: prev, toModel: currentInternalModel, status: 504, attempt },
          });
        }

        lastError = err;
        // Skip long backoff when budget is critically low — give the fallback model a fair attempt
        const budgetRemainingTimeout = REQUEST_TIMEOUT - requestTimer.elapsed();
        const backoffTimeout = budgetRemainingTimeout < 10_000 ? 0 : (recovery.backoffMs || computeOverloadBackoff(attempt));
        if (backoffTimeout > 0) await sleep(backoffTimeout);
        if (overloadEvents >= MAX_OVERLOAD_EVENTS) {
          logError('OVERLOAD', `Overload circuit breaker tripped (${overloadEvents} events) — failing fast`);
          throw err;
        }
        continue;
      }
      throw err;
    }
  }

  throw new Error('overloaded_error');
}
