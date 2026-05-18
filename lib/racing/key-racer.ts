/**
 * lib/racing/key-racer.ts
 *
 * Parallel key racing: run the same model/body across multiple keys and keep
 * the first successful response. Losing requests are actively aborted.
 */

import { getHealthiestKeyObj, reportKeyFailure, recordKeyUsage } from '../key-manager';
import { callGemini } from '../gemini-adapter';
import { logInfo, logWarn } from '../logging/event-logger';
import type { TaskType } from '../routing/task-router';

export interface KeyRaceResult {
  response: Response;
  keyId: string;
  latencyMs: number;
  racedKeys: number;
  winnerId: string;
}

export function getDynamicKeyCount(taskType: TaskType, isOverload = false, racingEnabled = false): number {
  if (!racingEnabled) return 1;
  if (isOverload) return 3;
  switch (taskType) {
    case 'CHAT':
    case 'HEALTH_CHECK':
    case 'COMPACTION':
      return 1;
    case 'LIGHT_CODING':
    case 'REASONING':
    case 'WEB_SEARCH':
      return 2;
    case 'HEAVY_CODING':
      return 3;
    default:
      return 1;
  }
}

async function gatherHealthyKeys(
  count: number,
  userId?: string
): Promise<Array<{ id: string; key: string }>> {
  const keys: Array<{ id: string; key: string }> = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < count * 2 && keys.length < count; i++) {
    const keyObj = await getHealthiestKeyObj(userId);
    if (!keyObj) break;
    if (seenIds.has(keyObj.id)) continue;
    seenIds.add(keyObj.id);
    keys.push(keyObj);
  }

  return keys;
}

function isAbortLike(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.toLowerCase().includes('abort');
}

export async function raceKeys(opts: {
  model: string;
  body: any;
  stream: boolean;
  keyCount?: number;
  userId?: string;
}): Promise<KeyRaceResult | null> {
  const { model, body, stream, keyCount = 3, userId } = opts;
  const start = Date.now();

  const keys = await gatherHealthyKeys(keyCount, userId);
  if (keys.length === 0) return null;

  if (keys.length === 1) {
    const keyObj = keys[0];
    try {
      const res = await callGemini(model, keyObj.key, body, stream);
      const latency = Date.now() - start;

      if (res.ok) {
        await recordKeyUsage(keyObj.id);
        logInfo('KEY_RACE', `Single key (no race): ${keyObj.id} in ${latency}ms`);
        return {
          response: res,
          keyId: keyObj.id,
          latencyMs: latency,
          racedKeys: 1,
          winnerId: keyObj.id,
        };
      }

      if (res.status === 429) await reportKeyFailure(keyObj.id, 'ratelimit');
      else if (res.status === 403) await reportKeyFailure(keyObj.id, 'auth');
      else if (res.status >= 500) await reportKeyFailure(keyObj.id, 'server');
      return null;
    } catch {
      return null;
    }
  }

  const controllers = keys.map(() => new AbortController());

  const racePromises = keys.map(async (keyObj, idx) => {
    try {
      const res = await callGemini(model, keyObj.key, body, stream, {
        signal: controllers[idx].signal,
      });

      if (res.ok) {
        for (let j = 0; j < controllers.length; j++) {
          if (j !== idx) {
            try { controllers[j].abort('lost key race'); } catch { /* noop */ }
          }
        }
        await recordKeyUsage(keyObj.id);
        return { response: res, keyId: keyObj.id, idx };
      }

      if (res.status === 429) await reportKeyFailure(keyObj.id, 'ratelimit');
      else if (res.status === 403) await reportKeyFailure(keyObj.id, 'auth');
      else if (res.status >= 500) await reportKeyFailure(keyObj.id, 'server');
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
    logInfo('KEY_RACE', `Won race: key=${winner.keyId} from ${keys.length} racers in ${latency}ms`);
    return {
      response: winner.response,
      keyId: winner.keyId,
      latencyMs: latency,
      racedKeys: keys.length,
      winnerId: winner.keyId,
    };
  }

  logWarn('KEY_RACE', `All ${keys.length} keys failed in race (${latency}ms)`);
  return null;
}
