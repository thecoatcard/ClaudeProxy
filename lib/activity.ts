/**
 * lib/activity.ts
 *
 * Per-request activity logging to Redis.
 * Fire-and-forget — never blocks the gateway response path.
 * Keeps the last MAX_ENTRIES entries in a Redis list (`activity:log`).
 */
import { redis } from './redis';

const MAX_ENTRIES = 1000;

export interface ActivityEntry {
  ts: number;           // Unix ms timestamp
  userKey: string;      // Masked gateway token
  model: string;        // Claude model alias requested
  geminiModel: string;  // Actual Gemini model used
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retries: number;
  status: 'success' | 'error';
  streaming: boolean;
  fallback: boolean;
  toolsUsed: number;
}

/** Mask a key token: keep first 8 and last 4 chars. */
export function maskToken(token: string): string {
  if (!token || token.length < 14) return (token?.slice(0, 6) ?? '') + '***';
  return token.slice(0, 8) + '…' + token.slice(-4);
}

/**
 * Log a request to the activity feed.
 * Call fire-and-forget: `logActivity({...}).catch(() => {})`.
 */
export async function logActivity(entry: ActivityEntry): Promise<void> {
  const key = 'activity:log';
  await redis.lpush(key, JSON.stringify(entry));
  await redis.ltrim(key, 0, MAX_ENTRIES - 1);
}

/** Read the most recent `limit` activity entries. */
export async function getActivity(limit = 100): Promise<ActivityEntry[]> {
  const raw = await redis.lrange('activity:log', 0, Math.min(limit, MAX_ENTRIES) - 1);
  const out: ActivityEntry[] = [];
  for (const item of raw) {
    try {
      out.push(JSON.parse(item) as ActivityEntry);
    } catch { /* skip corrupt entries */ }
  }
  return out;
}

/** Clear the activity log. */
export async function clearActivity(): Promise<void> {
  await redis.del('activity:log');
}
