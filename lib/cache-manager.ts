import { redis } from './redis';

// Minimum payload size before we bother creating an explicit cache.
// Gemini's explicit cache requires >=1024 tokens on 2.5-flash and >=4096 on 1.5 models.
// ~16000 chars is a conservative proxy for ~4k tokens.
const CACHE_MIN_CHARS = Number(process.env.GEMINI_CACHE_MIN_CHARS || 16000);

// Short TTL — Claude Code turns are seconds apart, so 5 min covers active sessions.
const CACHE_TTL_SECONDS = Number(process.env.GEMINI_CACHE_TTL || 300);

// Models that don't support explicit caching. Gemma models + lite previews sometimes reject.
const CACHE_UNSUPPORTED = new Set<string>([
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
]);

// Master switch. Defaults to OFF — explicit caching requires paid-tier quota
// on Google (free tier has limit=0 for most models), so leaving it off avoids
// a useless round-trip to cachedContents on every turn. Set
// GEMINI_CACHE_ENABLED=true to turn it on once billing is enabled.
const CACHE_ENABLED = process.env.GEMINI_CACHE_ENABLED === 'true';

export function isCacheSupported(internalModel: string): boolean {
  if (!CACHE_ENABLED) return false;
  if (CACHE_UNSUPPORTED.has(internalModel)) return false;
  if (internalModel.startsWith('gemma')) return false;
  return true;
}

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hashBuf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Split contents into a cacheable prefix and a live tail.
 * Returns null if payload is too small to benefit from caching.
 * The prefix excludes the last user turn so the live request stays small.
 */
export function splitForCache(geminiBody: any): { prefix: any; tail: any[] } | null {
  const contents = geminiBody.contents;
  if (!Array.isArray(contents) || contents.length < 3) return null;

  // Find index of the last user turn — everything up to that point is the prefix.
  let lastUserIdx = -1;
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 1) return null;

  const prefixContents = contents.slice(0, lastUserIdx);
  const tail = contents.slice(lastUserIdx);

  // Ensure the prefix is actually substantial.
  const prefixSize = JSON.stringify({
    contents: prefixContents,
    systemInstruction: geminiBody.systemInstruction,
    tools: geminiBody.tools,
  }).length;

  if (prefixSize < CACHE_MIN_CHARS) return null;

  // Explicit cache requires the prefix to end on a model turn (Gemini complains otherwise).
  if (prefixContents[prefixContents.length - 1].role !== 'model') return null;

  return {
    prefix: {
      contents: prefixContents,
      ...(geminiBody.systemInstruction ? { systemInstruction: geminiBody.systemInstruction } : {}),
      ...(geminiBody.tools ? { tools: geminiBody.tools } : {}),
    },
    tail,
  };
}

export async function prefixHash(
  internalModel: string,
  keyId: string,
  prefix: any
): Promise<string> {
  // Key by model + api key id + prefix so different accounts/models don't collide.
  const serialized = JSON.stringify({ m: internalModel, k: keyId, p: prefix });
  return sha256(serialized);
}

export async function lookupCache(hash: string): Promise<string | null> {
  const name = await redis.get<string>(`gemini:cache:${hash}`);
  return name && typeof name === 'string' ? name : null;
}

export async function saveCache(hash: string, cacheName: string): Promise<void> {
  // Keep Redis TTL slightly shorter than Gemini's so we never point at an expired cache.
  const ttl = Math.max(30, CACHE_TTL_SECONDS - 30);
  await redis.set(`gemini:cache:${hash}`, cacheName, { ex: ttl });
}

export async function deleteCache(hash: string): Promise<void> {
  await redis.del(`gemini:cache:${hash}`);
}

/**
 * Create an explicit cachedContent on Gemini's servers.
 * Returns the cache name (e.g. "cachedContents/abc123") or null on failure.
 */
export async function createCachedContent(
  internalModel: string,
  apiKey: string,
  prefix: any
): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${apiKey}`;
  const body = {
    model: `models/${internalModel}`,
    ...prefix,
    ttl: `${CACHE_TTL_SECONDS}s`,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn(`[cache] createCachedContent failed (${res.status}): ${err.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as { name?: string };
    return data.name || null;
  } catch (e) {
    console.warn('[cache] createCachedContent threw', e);
    return null;
  }
}

export { CACHE_TTL_SECONDS, CACHE_MIN_CHARS };
