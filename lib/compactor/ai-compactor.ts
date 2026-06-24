import { callGemini } from '../gemini-adapter';
import { getHealthiestKeyObj, reportKeyFailure } from '../key-manager';
import { redis } from '../redis';
import { stableHash } from '../utils/hash';

const COMPACTOR_MODEL = 'gemma-4-31b-it';
const COMPACTION_TOOL_OUTPUT_MAX_CHARS = Number(process.env.COMPACTION_TOOL_OUTPUT_MAX_CHARS || 4000);
const CHUNK_TIMEOUT_MS = Number(process.env.COMPACTION_CHUNK_TIMEOUT_MS || 20000);

export const COMPACTED_MARKER_SENTINEL = '<!-- compacted:v2 -->';
// BUG-009 FIX: v1 sentinel must also be recognised during hydration so that
// conversations compacted before the v2 migration are not silently broken.
const COMPACTED_MARKER_SENTINEL_V1 = '<!-- compacted:v1 -->';

export interface CompactedMemoryRecord {
  conversation_id: string;
  compacted_range: string;
  summary: string;
  timestamp: number;
}

export interface CompactorStore {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
}

const redisStore: CompactorStore = {
  async set(key, value, ttlSeconds) {
    await redis.set(key, value, { ex: ttlSeconds });
  },
  async get(key) {
    const v = await redis.get<string>(key);
    return typeof v === 'string' ? v : null;
  },
};

export function buildCompactedRangeId(messages: any[], start: number, end: number): string {
  const sig = `${start}:${end}:${messages.length}:${messages.map(m => `${m?.role || '?'}:${String(m?.content || '').slice(0, 64)}`).join('|')}`;
  return `${start}-${end}-${stableHash(sig).slice(0, 10)}`;
}

export function storageKey(conversationId: string, rangeId: string): string {
  return `context:compacted:${conversationId}:${rangeId}`;
}

export function buildCompactedMarker(rangeId: string): string {
  return `${COMPACTED_MARKER_SENTINEL}\n[COMPACTED RANGE]\nrange_id:${rangeId}\n[/COMPACTED RANGE]`;
}

export function parseCompactedRangeId(text: string): string | null {
  if (!text || !text.includes(COMPACTED_MARKER_SENTINEL)) return null;
  const m = text.match(/range_id\s*:\s*([^\n\r]+)/i);
  return m?.[1]?.trim() || null;
}

function pickSection(source: string, key: string): string {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'im');
  const m = source.match(re);
  return (m?.[1] || '').trim();
}

export function normalizeSummaryBlock(rawSummary: string): string {
  const summary = String(rawSummary || '').trim();

  const goal = pickSection(summary, 'Goal') || 'See consolidated objective in summary text.';
  const completed = pickSection(summary, 'Completed') || summary.slice(0, 260) || 'N/A';
  const failed = pickSection(summary, 'Failed') || 'N/A';
  const pending = pickSection(summary, 'Pending') || 'N/A';
  const files = pickSection(summary, 'Files') || 'N/A';
  const decisions = pickSection(summary, 'Decisions') || 'N/A';
  const blockers = pickSection(summary, 'Blockers') || 'N/A';

  return [
    '[COMPACTED MEMORY BLOCK]',
    `Goal: ${goal}`,
    `Completed: ${completed}`,
    `Failed: ${failed}`,
    `Pending: ${pending}`,
    `Files: ${files}`,
    `Decisions: ${decisions}`,
    `Blockers: ${blockers}`,
    '[/COMPACTED MEMORY BLOCK]',
  ].join('\n');
}

export function buildStoredSummaryMessage(rangeId: string, summary: string): string {
  return `${buildCompactedMarker(rangeId)}\n${normalizeSummaryBlock(summary)}`;
}

export async function saveCompactedSummary(
  conversationId: string,
  rangeId: string,
  summary: string,
  ttlSeconds: number,
  store: CompactorStore = redisStore,
): Promise<void> {
  const record: CompactedMemoryRecord = {
    conversation_id: conversationId,
    compacted_range: rangeId,
    summary,
    timestamp: Date.now(),
  };
  await store.set(storageKey(conversationId, rangeId), JSON.stringify(record), ttlSeconds);
}

export async function loadCompactedSummary(
  conversationId: string,
  rangeId: string,
  store: CompactorStore = redisStore,
): Promise<CompactedMemoryRecord | null> {
  const raw = await store.get(storageKey(conversationId, rangeId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.summary !== 'string') return null;
    return parsed as CompactedMemoryRecord;
  } catch {
    return null;
  }
}

export async function hydrateCompactedMarkers(
  messages: any[],
  conversationId: string,
  store: CompactorStore = redisStore,
): Promise<any[]> {
  if (!Array.isArray(messages)) return [];

  return Promise.all(messages.map(async (msg) => {
    if (!msg) return msg;

    if (typeof msg.content === 'string') {
      const rangeId = parseCompactedRangeId(msg.content);
      if (!rangeId) {
        if (msg.content.includes(COMPACTED_MARKER_SENTINEL_V1)) return msg;
        return msg;
      }
      const record = await loadCompactedSummary(conversationId, rangeId, store);
      if (record) return { ...msg, content: buildStoredSummaryMessage(rangeId, record.summary) };
      return msg;
    }

    if (Array.isArray(msg.content)) {
      let changed = false;
      const nextBlocks = msg.content.map((b: any) => {
        if (b?.type === 'text' && typeof b.text === 'string') {
           if (b.text.includes(COMPACTED_MARKER_SENTINEL_V1)) return b;
           const rid = parseCompactedRangeId(b.text);
           if (rid) {
             changed = true;
             return { ...b, __rangeId: rid };
           }
        }
        return b;
      });

      if (!changed) return msg;

      const resolvedBlocks = await Promise.all(nextBlocks.map(async (b: any) => {
        if (b?.__rangeId) {
          const record = await loadCompactedSummary(conversationId, b.__rangeId, store);
          return { type: 'text', text: record ? buildStoredSummaryMessage(b.__rangeId, record.summary) : b.text };
        }
        return b;
      }));
      return { ...msg, content: resolvedBlocks };
    }

    return msg;
  }));
}

async function callGeminiForCompaction(model: string, body: any, fallbackApiKey?: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const keyObj = await getHealthiestKeyObj(undefined);
    const apiKey = keyObj?.key || fallbackApiKey;
    if (!apiKey) return null;

    try {
      const res = await callGemini(model, apiKey, body, false);
      if (res.ok) {
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const textPart = parts.find((p: any) => p && typeof p.text === 'string' && !p.thought && p.text.trim());
        return textPart?.text?.trim() || null;
      }

      if (res.status === 429 || res.status >= 500) {
        if (keyObj) reportKeyFailure(keyObj.id, res.status === 429 ? 'ratelimit' : 'server').catch(() => {});
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      return null;
    } catch {
      if (attempt < 1) continue;
      return null;
    }
  }
  return null;
}

function formatMessagesForSummary(messages: any[]): string {
  return messages.map(msg => {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    let content = '';

    if (typeof msg.content === 'string') content = msg.content;
    else if (Array.isArray(msg.content)) {
      content = msg.content.map((b: any) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'thinking') return `[Thinking: ${b.thinking?.slice(0, 200) ?? ''}...]`;
        if (b.type === 'tool_use') return `[Tool Call: ${b.name}(${JSON.stringify(b.input).slice(0, 200)})]`;
        if (b.type === 'tool_result') {
          const raw = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c: any) => c.text || '').join('\n')
              : JSON.stringify(b.content);
          const capped = raw.length > COMPACTION_TOOL_OUTPUT_MAX_CHARS
            ? raw.slice(0, COMPACTION_TOOL_OUTPUT_MAX_CHARS) + `\n... [truncated ${raw.length - COMPACTION_TOOL_OUTPUT_MAX_CHARS} chars]`
            : raw;
          return `[Tool Output: ${capped}]`;
        }
        return `[${b.type}]`;
      }).join(' ');
    }

    return `${role}: ${content}`;
  }).join('\n\n');
}

function buildSummaryBody(historyText: string, maxOutputTokens: number): any {
  const prompt = `You are a conversation memory optimizer for a coding session.\n\nOutput ONLY this exact schema:\n[COMPACTED MEMORY BLOCK]\nGoal:\nCompleted:\nFailed:\nPending:\nFiles:\nDecisions:\nBlockers:\n[/COMPACTED MEMORY BLOCK]\n\nRules:\n- Preserve original goal and architecture decisions.\n- Preserve completed tasks, failed attempts, pending tasks, blockers.\n- Preserve active file paths and tool dependency chains.\n- Keep concise but semantically faithful.\n\nCONVERSATION:\n${historyText}`;

  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens, temperature: 0.25 },
  };
}

export async function generateChunkedSummary(
  messages: any[],
  apiKey: string,
  model: string = COMPACTOR_MODEL,
  chunkSize: number = 20,
): Promise<string | null> {
  if (!messages || messages.length === 0) return null;

  const chunks: any[][] = [];
  for (let i = 0; i < messages.length; i += chunkSize) chunks.push(messages.slice(i, i + chunkSize));

  const summaryPromises = chunks.map((chunk, idx) => {
    const staggerDelay = idx * 150;
    return new Promise<{ summary: string | null; idx: number }>(resolve => {
      setTimeout(async () => {
        const historyText = formatMessagesForSummary(chunk);
        const body = buildSummaryBody(historyText, 500);

        const result = await Promise.race([
          callGeminiForCompaction(COMPACTOR_MODEL, body, apiKey),
          new Promise<null>(r => setTimeout(() => r(null), CHUNK_TIMEOUT_MS)),
        ]);

        resolve({ summary: result, idx });
      }, staggerDelay);
    });
  });

  const results = await Promise.all(summaryPromises);
  const chunkSummaries: string[] = results
    .sort((a, b) => a.idx - b.idx)
    .map(r => r.summary)
    .filter((s): s is string => !!s);

  if (chunkSummaries.length === 0) return null;
  if (chunkSummaries.length === 1) return chunkSummaries[0];

  const combined = chunkSummaries.map((s, i) => `[Section ${i + 1}]\n${s}`).join('\n\n');
  const mergeBody = buildSummaryBody(combined, 700);
  const merged = await callGeminiForCompaction(COMPACTOR_MODEL, mergeBody, apiKey);
  return merged || chunkSummaries.join('\n\n---\n\n');
}
