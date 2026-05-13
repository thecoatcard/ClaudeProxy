/**
 * lib/racing/model-racer.ts
 *
 * Parallel model racing — for overload-sensitive requests, race multiple models
 * simultaneously. First healthy response wins, others are cancelled.
 *
 * Dynamic model racing by task type:
 *   CHAT             → off  (single model, too cheap to race)
 *   HEALTH_CHECK     → off
 *   COMPACTION       → off  (background)
 *   LIGHT_CODING     → 2 models
 *   HEAVY_CODING     → 3 models
 *   REASONING        → off  (gemma primary — race only on failure, not default)
 *   WEB_SEARCH       → 2 models
 *   overload         → enable (any task type becomes 2-3 model race)
 */

import { getHealthiestKeyObj, reportKeyFailure, recordKeyUsage } from '../key-manager';
import { callGemini } from '../gemini-adapter';
import { logInfo, logWarn } from '../logging/event-logger';
import { getTaskModelChain, type TaskType } from '../routing/task-router';

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

// ---------------------------------------------------------------------------
// Dynamic model race config by task type
// ---------------------------------------------------------------------------

export interface ModelRaceConfig {
  /** Whether model racing is enabled for this task type */
  enabled: boolean;
  /** Number of models to race (taken from head of task chain) */
  modelCount: number;
}

/**
 * Get the dynamic model race config for a given task type.
 *
 * REASONING uses Gemma primary — racing Gemma vs Gemini defeats the purpose.
 * CHAT and HEALTH_CHECK are too cheap to race.
 * HEAVY_CODING benefits most from racing (highest latency sensitivity).
 */
export function getDynamicModelRaceConfig(taskType: TaskType, isOverload = false, racingEnabled = false): ModelRaceConfig {
  if (!racingEnabled) return { enabled: false, modelCount: 1 };
  if (isOverload) return { enabled: true, modelCount: 3 };

  switch (taskType) {
    case 'CHAT':
    case 'HEALTH_CHECK':
    case 'COMPACTION':
    case 'REASONING':
      return { enabled: false, modelCount: 1 };
    case 'LIGHT_CODING':
    case 'WEB_SEARCH':
      return { enabled: true, modelCount: 2 };
    case 'HEAVY_CODING':
      return { enabled: true, modelCount: 3 };
    default:
      return { enabled: false, modelCount: 1 };
  }
}

/**
 * Get the models to use for a racing config, pulled from the task's chain.
 */
export function getModelsForRace(taskType: TaskType, count: number): string[] {
  const chain = getTaskModelChain(taskType);
  return chain.slice(0, count);
}

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

  // Wait for the first success, or until all have failed
  const winner = await new Promise<any>((resolve) => {
    let completed = 0;
    let resolved = false;

    racePromises.forEach((p) => {
      p.then((val) => {
        completed++;
        if (val && !resolved) {
          resolved = true;
          resolve(val);
        } else if (completed === racePromises.length && !resolved) {
          resolve(null);
        }
      }).catch(() => {
        completed++;
        if (completed === racePromises.length && !resolved) {
          resolve(null);
        }
      });
    });
  });

  const latency = Date.now() - start;

  if (winner) {
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

  logWarn('MODEL_RACE', `All ${racers.length} models failed in race (${latency}ms)`);
  return null;
}
