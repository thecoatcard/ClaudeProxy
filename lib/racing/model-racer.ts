/**
 * lib/racing/model-racer.ts
 *
 * Parallel model racing: race multiple models and keep first healthy response.
 * Uses distinct keys when possible and aborts losing model requests.
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

const DEFAULT_RACE_MODELS = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

export interface ModelRaceConfig {
  enabled: boolean;
  modelCount: number;
}

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

export function getModelsForRace(taskType: TaskType, count: number): string[] {
  const chain = getTaskModelChain(taskType);
  return chain.slice(0, count);
}

function isAbortLike(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.toLowerCase().includes('abort');
}

export async function raceModels(opts: {
  models?: string[];
  body: any;
  stream: boolean;
  userId?: string;
  bodyTransformer?: (model: string, body: any) => any;
}): Promise<ModelRaceResult | null> {
  const { models = DEFAULT_RACE_MODELS, body, stream, userId, bodyTransformer } = opts;
  const start = Date.now();

  if (models.length === 0) return null;

  // Gather one distinct key per model when possible. If the account has only one
  // key, skip fan-out to avoid burning rate limits on duplicate requests.
  const racers: Array<{ model: string; keyId: string; apiKey: string }> = [];
  const usedKeyIds = new Set<string>();

  for (const model of models) {
    const keyObj = await getHealthiestKeyObj(userId);
    if (!keyObj) continue;
    if (usedKeyIds.has(keyObj.id)) continue;
    racers.push({ model, keyId: keyObj.id, apiKey: keyObj.key });
    usedKeyIds.add(keyObj.id);
  }

  if (racers.length === 0) return null;

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

  const controllers = racers.map(() => new AbortController());

  const racePromises = racers.map(async (racer, idx) => {
    const transformedBody = bodyTransformer ? bodyTransformer(racer.model, body) : body;
    try {
      const res = await callGemini(racer.model, racer.apiKey, transformedBody, stream, {
        signal: controllers[idx].signal,
      });

      if (res.ok) {
        for (let j = 0; j < controllers.length; j++) {
          if (j !== idx) {
            try { controllers[j].abort('lost model race'); } catch { /* noop */ }
          }
        }
        await recordKeyUsage(racer.keyId);
        return { response: res, model: racer.model, keyId: racer.keyId, idx };
      }

      if (res.status === 429) await reportKeyFailure(racer.keyId, 'ratelimit');
      else if (res.status === 403) await reportKeyFailure(racer.keyId, 'auth');
      else if (res.status >= 500) await reportKeyFailure(racer.keyId, 'server');
      return null;
    } catch (err) {
      if (isAbortLike(err)) return null;
      return null;
    }
  });

  const winner = await new Promise<any>((resolve) => {
    let completed = 0;
    let resolved = false;

    racePromises.forEach((p) => {
      p.then((val) => {
        completed++;
        if (val && !resolved) {
          resolved = true;
          resolve(val);
          return;
        }
        if (completed === racePromises.length && !resolved) {
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
