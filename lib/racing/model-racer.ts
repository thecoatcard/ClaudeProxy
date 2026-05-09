/**
 * lib/racing/model-racer.ts
 *
 * Parallel model racing — for overload-sensitive requests, race multiple models
 * simultaneously. First healthy response wins, others are cancelled.
 *
 * Use case: when a primary model is likely overloaded, don't wait for serial
 * fallback. Instead, fire requests to 2-3 models in parallel and take whichever
 * responds first with a valid result.
 */

import { getHealthiestKeyObj, reportKeyFailure, recordKeyUsage } from '../key-manager';
import { callGemini } from '../gemini-adapter';
import { logInfo, logWarn } from '../logging/event-logger';

export interface ModelRaceResult {
  response: Response;
  model: string;
  keyId: string;
  latencyMs: number;
  racedModels: number;
  winnerModel: string;
}

/** Default models to race for overload-sensitive requests. */
const DEFAULT_RACE_MODELS = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

/**
 * Race multiple models in parallel with independent keys.
 *
 * Each model gets its own healthy API key. All fire simultaneously.
 * First 2xx response wins; others are abandoned.
 *
 * Returns null if no models produce a successful response.
 */
export async function raceModels(opts: {
  models?: string[];
  body: any;
  stream: boolean;
  userId?: string;
  /** Body transformers per model (e.g., strip images for text-only). */
  bodyTransformer?: (model: string, body: any) => any;
}): Promise<ModelRaceResult | null> {
  const { models = DEFAULT_RACE_MODELS, body, stream, userId, bodyTransformer } = opts;
  const start = Date.now();

  if (models.length === 0) return null;

  // Gather one key per model (different keys preferred for true parallelism)
  const racers: Array<{ model: string; keyId: string; apiKey: string }> = [];
  const usedKeyIds = new Set<string>();

  for (const model of models) {
    const keyObj = await getHealthiestKeyObj(userId);
    if (!keyObj) continue;
    racers.push({ model, keyId: keyObj.id, apiKey: keyObj.key });
    usedKeyIds.add(keyObj.id);
  }

  if (racers.length === 0) return null;

  // Single model — no race
  if (racers.length === 1) {
    const racer = racers[0];
    const transformedBody = bodyTransformer ? bodyTransformer(racer.model, body) : body;
    try {
      const res = await callGemini(racer.model, racer.apiKey, transformedBody, stream);
      const latency = Date.now() - start;
      if (res.ok) {
        await recordKeyUsage(racer.keyId);
        logInfo('MODEL_RACE', `Single model (no race): ${racer.model} in ${latency}ms`);
        return {
          response: res,
          model: racer.model,
          keyId: racer.keyId,
          latencyMs: latency,
          racedModels: 1,
          winnerModel: racer.model,
        };
      }
      if (res.status >= 500) await reportKeyFailure(racer.keyId, 'server');
      return null;
    } catch {
      return null;
    }
  }

  // Multi-model race
  const racePromises = racers.map(async (racer, idx) => {
    const transformedBody = bodyTransformer ? bodyTransformer(racer.model, body) : body;
    try {
      const res = await callGemini(racer.model, racer.apiKey, transformedBody, stream);

      if (res.ok) {
        await recordKeyUsage(racer.keyId);
        return { response: res, model: racer.model, keyId: racer.keyId, idx };
      }

      // Report failures
      if (res.status === 429) await reportKeyFailure(racer.keyId, 'ratelimit');
      else if (res.status === 403) await reportKeyFailure(racer.keyId, 'auth');
      else if (res.status >= 500) await reportKeyFailure(racer.keyId, 'server');
      return null;
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(racePromises);
  const latency = Date.now() - start;

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const winner = result.value;
      logInfo('MODEL_RACE', `Won race: ${winner.model} from ${racers.length} models in ${latency}ms`);
      return {
        response: winner.response,
        model: winner.model,
        keyId: winner.keyId,
        latencyMs: latency,
        racedModels: racers.length,
        winnerModel: winner.model,
      };
    }
  }

  logWarn('MODEL_RACE', `All ${racers.length} models failed in race (${latency}ms)`);
  return null;
}
