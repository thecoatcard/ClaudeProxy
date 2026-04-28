import { getHealthiestKeyObj, reportKeyFailure, recordKeyUsage } from './key-manager';
import { getModelMapping } from './model-router';
import { callGemini } from './gemini-adapter';
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
            if (p && 'thoughtSignature' in p) {
              const { thoughtSignature, ...rest } = p;
              return rest;
            }
            return p;
          })
        : c.parts,
    })),
  };
}

/**
 * Replace the body's prefix with a cachedContent reference when we have a hit.
 * Falls back to creating a new cache on miss. Returns the body to send, or the
 * original body if caching isn't beneficial.
 */
async function applyCache(
  internalModel: string,
  keyId: string,
  apiKey: string,
  body: any
): Promise<any> {
  if (!isCacheSupported(internalModel)) return body;

  const split = splitForCache(body);
  if (!split) return body;

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
      return body;
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
    ...rest,
    contents: cleanTail,
    cachedContent: cacheName,
  };
}

export async function executeWithRetry(
  anthropicModel: string,
  geminiBody: any,
  stream: boolean
) {
  const modelMap = await getModelMapping(anthropicModel);
  const fallbacks = Array.isArray(modelMap.fallback) ? modelMap.fallback : (modelMap.fallback ? [modelMap.fallback] : []);
  const configuredRetries = Number(process.env.MAX_RETRIES || 3);
  const maxRetries = Math.max(configuredRetries, (fallbacks.length * 2) + 2);

  const primaryModel = modelMap.primary;
  let currentInternalModel = primaryModel;
  let fallbackIndex = 0;
  let lastError;
  let stripSigs = false;
  let skipCache = false;
  let lastCacheHash: string | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const keyObj = await getHealthiestKeyObj();

    if (!keyObj) {
      throw new Error('overloaded_error'); // will be mapped to 529
    }

    // thoughtSignatures are only valid for the model that produced them.
    // If we fall back to a different model (or a previous 400 hinted at a
    // signature mismatch), strip them to avoid INVALID_ARGUMENT errors.
    let bodyForThisAttempt = (currentInternalModel !== primaryModel || stripSigs)
      ? stripThoughtSignatures(geminiBody)
      : geminiBody;

    // Fast-fail: strip images before sending to text-only models so we don't
    // pay a round-trip 400 just to discover the model can't read them.
    if (isTextOnly(currentInternalModel)) {
      bodyForThisAttempt = stripImagesFromBody(bodyForThisAttempt);
    }

    // Swap the prefix for a cachedContent reference when the payload is large.
    // skipCache is flipped after a cache-related 400 so the retry doesn't
    // rebuild the same broken reference on Google's side.
    if (!skipCache) {
      try {
        bodyForThisAttempt = await applyCache(
          currentInternalModel,
          keyObj.id,
          keyObj.key,
          bodyForThisAttempt
        );
        // Remember the hash so we can invalidate on a cache-caused 400.
        const split = splitForCache(geminiBody);
        if (split && isCacheSupported(currentInternalModel)) {
          lastCacheHash = await prefixHash(
            currentInternalModel,
            keyObj.id,
            stripThoughtSignatures(split.prefix)
          );
        } else {
          lastCacheHash = null;
        }
      } catch (e) {
        // Caching is a best-effort optimization — never fail the request over it.
        console.warn('[retry] cache apply failed, proceeding without', e);
      }
    } else {
      lastCacheHash = null;
    }

    try {
      const res = await callGemini(currentInternalModel, keyObj.key, bodyForThisAttempt, stream);

      if (res.status === 429) {
        await reportKeyFailure(keyObj.id, true);
        lastError = { status: 429 };
        continue;
      }

      if (res.status === 503 || res.status >= 500) {
        await reportKeyFailure(keyObj.id, false);

        // Improve fallback: Try at least 2 keys on the current model before degrading
        if (attempt % 2 === 0 && fallbackIndex < fallbacks.length) {
          currentInternalModel = fallbacks[fallbackIndex];
          fallbackIndex++;
        }
        lastError = { status: res.status };
        continue;
      }

      if (!res.ok) {
        const err = await res.json().catch(()=>({}));
        console.error("Gemini API Error:", JSON.stringify(err, null, 2));
        console.error("DEBUG PAYLOAD:", JSON.stringify({
          model: currentInternalModel,
          stripSigs,
          geminiBody: bodyForThisAttempt,
          error: err,
        }));

        const msg = err?.error?.message || '';

        // Cache miss / expired / bad reference: drop the mapping, flip the
        // skip flag so the next attempt sends the full uncached body.
        const isCacheErr = res.status === 400 && /cached ?content|cache/i.test(msg);
        if (isCacheErr && lastCacheHash) {
          await deleteCache(lastCacheHash);
          lastCacheHash = null;
          skipCache = true;
          lastError = { status: 400 };
          continue;
        }

        // On 400 INVALID_ARGUMENT, retry once with thoughtSignatures stripped —
        // mismatched/stale sigs are a common cause of this error.
        const isInvalidArg = res.status === 400 && /invalid argument|INVALID_ARGUMENT/i.test(msg);
        const hasSigs = JSON.stringify(bodyForThisAttempt).includes('thoughtSignature');
        if (isInvalidArg && hasSigs && !stripSigs) {
          stripSigs = true;
          lastError = { status: 400 };
          continue;
        }

        throw { status: res.status, data: err };
      }

      // Success
      await recordKeyUsage(keyObj.id);
      return res;
    } catch (err: any) {
      if (err.message === 'overloaded_error') throw err;
      if (err.status === 400) throw err; // Safety or bad request
      if (err.name === 'AbortError' || err.message?.includes('timeout')) {
        await reportKeyFailure(keyObj.id, false);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw new Error('overloaded_error');
}
