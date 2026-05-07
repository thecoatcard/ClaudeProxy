import { getHealthiestKeyObj, reportKeyFailure, recordKeyUsage } from './key-manager';
import { getModelMapping } from './model-router';
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

function stripThoughtSignatures(body: any): any {
  if (!body || !Array.isArray(body.contents)) return body;
  return {
    ...body,
    contents: body.contents.map((c: any) => ({
      ...c,
      parts: Array.isArray(c.parts)
        ? c.parts.map((p: any) => {
            // ONLY strip thoughtSignature from thought TEXT parts (parts with thought:true or text only).
            // functionCall parts MUST keep their thoughtSignature — removing it while
            // thinkingConfig is active causes a 400 "missing thought_signature" error.
            // Non-thinking models silently ignore the extra field, so keeping it is safe.
            if (p && 'thoughtSignature' in p && !p.functionCall) {
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

async function rememberLastWorkingModel(userId: string | undefined, anthropicModel: string, internalModel: string) {
  if (!userId) return;
  try {
    await redis.set(`route:last:${userId}:${anthropicModel.toLowerCase()}`, internalModel, { ex: 1800 });
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
  routePlan?: ModelRoute
) {
  const isThinkingRequested = !!geminiBody.generationConfig?.thinkingConfig;
  const modelMap = routePlan || await getModelMapping(anthropicModel, { thinkingEnabled: isThinkingRequested, userId });
  const fallbacks = Array.isArray(modelMap.fallback) ? modelMap.fallback : (modelMap.fallback ? [modelMap.fallback] : []);
  const configuredRetries = Number(process.env.MAX_RETRIES || 3);
  const maxRetries = Math.max(configuredRetries, (fallbacks.length * 2) + 2);

  const primaryModel = modelMap.primary;
  let currentInternalModel = primaryModel;
  let fallbackIndex = 0;
  let lastError;
  let stripSigs = false;
  let stripThinking = false;
  let skipCache = false;
  let lastCacheHash: string | null = null;
  // Tracks distinct models that returned 503 — when all chain models are
  // exhausted we break early instead of burning remaining retries on models
  // that are confirmed overloaded. This cuts worst-case latency from ~25s to ~8s.
  const overloadedModels = new Set<string>();
  // When Gemini returns 400 "max tokens exceeded", we reduce maxOutputTokens
  // for all subsequent attempts. Null = use the value already in geminiBody.
  let maxOutputTokensOverride: number | null = null;
  // Break after this many DISTINCT models return 503. Default 3 means:
  // primary + 2 fallbacks all overloaded → it’s a Gemini outage, give up fast.
  // At 2 we were failing too aggressively on long sessions where capacity is
  // patchy (primary down, but fallback 2 still works). 3 is a better balance
  // of latency vs resilience. Increase via OVERLOAD_FAST_FAIL_AFTER env var.
  const OVERLOAD_FAST_FAIL_AFTER = Number(process.env.OVERLOAD_FAST_FAIL_AFTER || 3);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const keyObj = await getHealthiestKeyObj(userId);

    if (!keyObj) {
      throw new Error('overloaded_error'); // will be mapped to 529
    }

    // thoughtSignatures are only valid for the model that produced them.
    // If we fall back to a different model (or a previous 400 hinted at a
    // signature mismatch), strip them to avoid INVALID_ARGUMENT errors.
    let bodyForThisAttempt = (currentInternalModel !== primaryModel || stripSigs)
      ? stripThoughtSignatures(geminiBody)
      : geminiBody;

    // If a previous attempt hit a 400 related to thinking (budget/unsupported),
    // strip thinking config for the next attempt.
    if (stripThinking && bodyForThisAttempt.generationConfig?.thinkingConfig) {
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
        console.warn('[retry] cache apply failed, proceeding without', e);
      }
    } else {
      lastCacheHash = null;
    }

    try {
      const res = await callGemini(currentInternalModel, keyObj.key, bodyForThisAttempt, stream);

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

      if (res.status === 503 || res.status >= 500) {
        // Only penalize the API key if this is the FIRST overload we've seen.
        // If a second model is also returning 503, it's a Gemini-wide model outage
        // (not a key issue). Don't put healthy keys into 20s cooldown just because
        // Gemini's servers are struggling — that depletes the pool for the next request.
        if (overloadedModels.size === 0) {
          await reportKeyFailure(keyObj.id, 'server'); // 1st failure: might be key-specific
        } else {
          // Global outage mode: reduce score slightly so scheduler prefers other keys,
          // but keep the key IN THE POOL and available (it's not actually broken).
          redis.zadd('gemini:key_pool', { score: 75, member: keyObj.id }).catch(() => {});
        }
        overloadedModels.add(currentInternalModel);

        // Rotate immediately to the next model.
        if (fallbackIndex < fallbacks.length) {
          currentInternalModel = fallbacks[fallbackIndex++];
        }

        // Fast-exit: enough distinct models have failed to confirm a Gemini-wide outage.
        if (overloadedModels.size >= OVERLOAD_FAST_FAIL_AFTER) {
          console.warn(`[retry] ${overloadedModels.size} distinct models overloaded — Gemini outage detected. Failing fast after ${attempt} attempt(s).`);
          break;
        }

        lastError = { status: res.status };
        await sleep(computeBackoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err?.error?.message || err?.message || '';

        // Handle 503 Service Unavailable or 500 Internal Server Error
        // Also handle transient 400 "unexpected error" as a server-side glitch
        const isTransientBackendErr = (res.status === 400 && /unexpected error|internal error|service is currently unavailable/i.test(msg));
        
        if (res.status === 503 || res.status >= 500 || isTransientBackendErr) {
          if (overloadedModels.size === 0) {
            await reportKeyFailure(keyObj.id, 'server');
          } else {
            redis.zadd('gemini:key_pool', { score: 75, member: keyObj.id }).catch(() => {});
          }
          overloadedModels.add(currentInternalModel);

          if (fallbackIndex < fallbacks.length) {
            currentInternalModel = fallbacks[fallbackIndex++];
          }

          if (overloadedModels.size >= OVERLOAD_FAST_FAIL_AFTER) {
            console.warn(`[retry] ${overloadedModels.size} distinct models overloaded (body parse) — failing fast.`);
            break;
          }

          lastError = { status: res.status, message: msg };
          await sleep(computeBackoffMs(attempt));
          continue;
        }

        console.error("Gemini API Error:", JSON.stringify(err, null, 2));
        console.error("DEBUG PAYLOAD:", JSON.stringify({
          model: currentInternalModel,
          stripSigs,
          geminiBody: bodyForThisAttempt,
          error: err,
        }));

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
            console.warn(`[retry] thought_signature 400 on ${currentInternalModel} — disabling thinking for next attempt.`);
            lastError = { status: 400, message: msg };
            await sleep(computeBackoffMs(attempt));
            continue;
          }

          // Max output tokens exceeded — extract model's actual limit and retry.
          const isTokenLimitErr = /max.?token|token.?limit|exceed.*token/i.test(msg);
          if (isTokenLimitErr) {
            const limitMatch = msg.match(/(\d{4,6})/);
            const modelActualLimit = limitMatch ? Number(limitMatch[1]) : 32000;
            maxOutputTokensOverride = Math.floor(modelActualLimit * 0.9);
            console.warn(`[retry] Max token 400 on ${currentInternalModel}: reported limit=${modelActualLimit}, retrying with ${maxOutputTokensOverride}`);
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
            currentInternalModel = fallbacks[fallbackIndex];
            fallbackIndex++;
          }

          lastError = { status: 400, message: msg };
          await sleep(computeBackoffMs(attempt));
          continue;
        }

        throw { status: res.status, data: err };
      }

      // Success
      await recordKeyUsage(keyObj.id);
      await rememberLastWorkingModel(userId, anthropicModel, currentInternalModel);
      return res;
    } catch (err: any) {
      if (err.message === 'overloaded_error') throw err;
      
      // If it's a 400 (likely safety or bad request), try one more time with a fallback model
      if (err.status === 400 && fallbackIndex < fallbacks.length) {
        currentInternalModel = fallbacks[fallbackIndex];
        fallbackIndex++;
        lastError = err;
        await sleep(computeBackoffMs(attempt));
        continue;
      }

      if (err.name === 'AbortError' || err.message?.includes('timeout')) {
        await reportKeyFailure(keyObj.id, 'server');
        lastError = err;
        await sleep(computeBackoffMs(attempt));
        continue;
      }
      throw err;
    }
  }

  // All retries exhausted. Log diagnostic info for long-session debugging.
  const msgCount = geminiBody?.contents?.length ?? 0;
  const approxTokens = Math.round(
    JSON.stringify(geminiBody?.contents ?? []).length / 4
  );
  console.error(
    `[retry] overloaded_error after ${maxRetries} attempts | model=${anthropicModel}` +
    ` | turns=${msgCount} | ~${approxTokens} tokens in payload | overloadedModels=[${[...overloadedModels].join(',')}]`
  );
  throw new Error('overloaded_error');
}
