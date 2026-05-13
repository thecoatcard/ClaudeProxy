/**
 * lib/racing/key-racer.ts
 *
 * Parallel key racing — run the same request against multiple healthy API keys
 * simultaneously. Take the fastest successful response, cancel the rest.
 *
 * This eliminates serial key retry latency (was: try key1 → fail → backoff →
 * try key2 → fail → backoff → try key3). Now: race key1/key2/key3 in parallel,
 * first healthy response wins.
 *
 * Dynamic key count (by task type):
 *   CHAT / HEALTH_CHECK  → 1 key (cheap, no need to race)
 *   LIGHT_CODING         → 2 keys
 *   HEAVY_CODING         → 2-3 keys
 *   OVERLOAD_RECOVERY    → 3 keys (max parallelism)
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

// ---------------------------------------------------------------------------
// Dynamic key count by task type
// ---------------------------------------------------------------------------

/**
 * Returns the number of keys to race in parallel for a given task type.
 *
 * Rules:
 *   CHAT / HEALTH_CHECK  → 1  (trivial — no racing overhead)
 *   COMPACTION           → 1  (background task)
 *   LIGHT_CODING         → 2  (moderate latency benefit)
 *   HEAVY_CODING         → 3  (latency critical)
 *   REASONING            → 2  (gemma primary — race only if overloaded)
 *   WEB_SEARCH           → 2  (already has 8s timeout, moderate racing)
 *   overload             → 3  (maximum racing for recovery)
 */
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

export interface KeyRaceResult {
  response: Response;
  keyId: string;
  latencyMs: number;
  racedKeys: number;
  winnerId: string;
}

/**
 * Gather up to `count` distinct healthy keys from the pool.
 * Returns at least 1 key if any are available, up to `count`.
 */
async function gatherHealthyKeys(
  count: number,
  userId?: string
): Promise<Array<{ id: string; key: string }>> {
  const keys: Array<{ id: string; key: string }> = [];
  const seenIds = new Set<string>();

  // Try up to count*2 attempts to get distinct keys
  for (let i = 0; i < count * 2 && keys.length < count; i++) {
    const keyObj = await getHealthiestKeyObj(userId);
    if (!keyObj) break;
    if (seenIds.has(keyObj.id)) continue;
    seenIds.add(keyObj.id);
    keys.push(keyObj);
  }

  return keys;
}

/**
 * Race multiple API keys in parallel for the same model+body.
 *
 * - Gathers up to `keyCount` healthy keys
 * - Fires callGemini for each simultaneously
 * - First successful response (2xx) wins; others are abandoned
 * - Failed keys get reported via reportKeyFailure
 * - Falls back to single-key if only 1 available
 *
 * Returns null if no keys are available.
 */
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

  // Single key — no race needed
  if (keys.length === 1) {
    const keyObj = keys[0];
    try {
      const res = await callGemini(model, keyObj.key, body, stream);
      const latency = Date.now() - start;

      if (res.ok) {
        await recordKeyUsage(keyObj.id);
        logInfo('KEY_RACE', `Single key (no race): ${keyObj.id} in ${latency}ms`);
        return { response: res, keyId: keyObj.id, latencyMs: latency, racedKeys: 1, winnerId: keyObj.id };
      }

      // Report failure
      if (res.status === 429) await reportKeyFailure(keyObj.id, 'ratelimit');
      else if (res.status === 403) await reportKeyFailure(keyObj.id, 'auth');
      else if (res.status >= 500) await reportKeyFailure(keyObj.id, 'server');
      return null;
    } catch {
      return null;
    }
  }

  // Multi-key race using AbortController per racer
  const controllers = keys.map(() => new AbortController());

  const racePromises = keys.map(async (keyObj, idx) => {
    try {
      const res = await callGemini(model, keyObj.key, body, stream);

      if (res.ok) {
        // Winner — cancel all other racers
        for (let j = 0; j < controllers.length; j++) {
          if (j !== idx) controllers[j].abort();
        }
        await recordKeyUsage(keyObj.id);
        return { response: res, keyId: keyObj.id, idx };
      }

      // Report failure for non-OK responses
      if (res.status === 429) await reportKeyFailure(keyObj.id, 'ratelimit');
      else if (res.status === 403) await reportKeyFailure(keyObj.id, 'auth');
      else if (res.status >= 500) await reportKeyFailure(keyObj.id, 'server');
      return null;
    } catch (err: any) {
      if (err.name === 'AbortError') return null; // cancelled by winner
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
