import { callGemini } from '../gemini-adapter';
import { getHealthiestKeyObj, reportKeyFailure } from '../key-manager';

// ── Configuration ─────────────────────────────────────────────────────────────

// Max chars of tool output included per message during summarization.
// We only need the key facts, not a full replay. 4k chars captures enough
// detail (e.g. file path + first/last 100 lines) without exploding input size.
// Old value was 15,000 — that made each chunk ~300k chars which always timed out.
const COMPACTION_TOOL_OUTPUT_MAX_CHARS = Number(
  process.env.COMPACTION_TOOL_OUTPUT_MAX_CHARS || 4000
);

// Per-chunk timeout for the AI summarization call. 140s (+120s increase) gives Gemma
// plenty of time for large chunks without falling back to heuristics.
const CHUNK_TIMEOUT_MS = Number(process.env.COMPACTION_CHUNK_TIMEOUT_MS || 140000);

// ── Key-rotating Gemini caller for compaction ─────────────────────────────────

/**
 * Lightweight wrapper around callGemini with 2-attempt key rotation.
 *
 * Why separate from executeWithRetry:
 * - Compaction runs in a system context, not the user request hot path.
 * - We want to use system keys from the pool without interfering with the
 *   main retry engine's key management.
 * - Simpler: just 2 attempts with key rotation (no full retry loop needed).
 *
 * Returns the response text on success, or null on any failure.
 */
async function callGeminiForCompaction(
  model: string,
  body: any,
  fallbackApiKey?: string
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Always get a fresh key from the pool — the passed fallbackApiKey might
    // be the same one being used for the main request and may already be
    // rate-limited. Getting a distinct key avoids cross-contamination.
    const keyObj = await getHealthiestKeyObj(undefined);
    const apiKey = keyObj?.key || fallbackApiKey;
    if (!apiKey) return null;

    try {
      const res = await callGemini(model, apiKey, body, false);

      if (res.ok) {
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const textPart = parts.find(
          (p: any) => p && typeof p.text === 'string' && !p.thought && p.text.trim()
        );
        return textPart?.text?.trim() || null;
      }

      // 429 = rate-limited, 5xx = transient — mark key and try another.
      if (res.status === 429 || res.status >= 500) {
        if (keyObj) {
          const failType = res.status === 429 ? 'ratelimit' : 'server';
          reportKeyFailure(keyObj.id, failType).catch(() => {});
        }
        // A small pause before the retry avoids hammering an overloaded pool.
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue; // try with a different key
      }

      // 4xx other than 429 → payload/model issue, not a key problem.
      console.warn(`[AI-Compactor] Non-retryable ${res.status} on ${model} — skipping.`);
      return null;
    } catch {
      // Network / timeout / AbortError — try a different key on next attempt.
      if (attempt < 1) continue;
      return null;
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates a semantic summary of removed conversation turns.
 * Used for single-pass compaction of small history blocks.
 */
export async function generateSemanticSummary(
  removedMessages: any[],
  apiKey: string,
  model: string = 'gemma-4-31b-it'
): Promise<string | null> {
  if (!removedMessages || removedMessages.length === 0) return null;

  const historyText = formatMessagesForSummary(removedMessages);
  const body = buildSummaryBody(historyText, 500);
  return callGeminiForCompaction(model, body, apiKey);
}

/**
 * Splits `messages` into chunks, summarizes each in parallel (with key rotation
 * and per-chunk timeouts), then merges all summaries into one Memory Block.
 *
 * Falls back gracefully:
 *   - Chunk call 429/503 → retries with a different key.
 *   - Chunk still fails → heuristic fallback in compaction.ts fills the gap.
 *   - Merge call fails → chunk summaries joined with separator.
 */
export async function generateChunkedSummary(
  messages: any[],
  apiKey: string,
  model: string = 'gemma-4-31b-it',
  chunkSize: number = 20
): Promise<string | null> {
  if (!messages || messages.length === 0) return null;

  // ── 1. Slice into chunks ──────────────────────────────────────────────────
  const chunks: any[][] = [];
  for (let i = 0; i < messages.length; i += chunkSize) {
    chunks.push(messages.slice(i, i + chunkSize));
  }

  console.log(
    `[AI-Compactor] Chunked mode: ${messages.length} messages → ${chunks.length} chunk(s) of ≤${chunkSize}`
  );

  // ── 2. Summarize chunks in parallel, each with its own timeout ────────────
  // Chunks are staggered by 150ms to avoid hitting the same key simultaneously.
  // Each chunk uses getHealthiestKeyObj() independently so they naturally spread
  // across different keys in the pool.
  const summaryPromises = chunks.map((chunk, idx) => {
    const staggerDelay = idx * 150; // 0ms, 150ms, 300ms ...
    return new Promise<{ summary: string | null; idx: number }>(resolve => {
      setTimeout(async () => {
        const historyText = formatMessagesForSummary(chunk);
        const body = buildSummaryBody(historyText, 500);

        const result = await Promise.race([
          callGeminiForCompaction(model, body, apiKey),
          new Promise<null>(r => setTimeout(() => r(null), CHUNK_TIMEOUT_MS))
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

  const failedCount = chunks.length - chunkSummaries.length;
  if (failedCount > 0) {
    console.warn(
      `[AI-Compactor] ${failedCount} chunk(s) timed out or failed — using heuristic for those.`
    );
  }

  if (chunkSummaries.length === 0) return null;

  // ── 3. Merge (skip for 1–2 chunks — concatenation is equivalent quality) ──
  if (chunkSummaries.length <= 2) {
    return chunkSummaries.join('\n\n---\n\n');
  }

  const merged = await mergeSummaries(chunkSummaries, apiKey, model);
  if (merged) return merged;

  console.warn('[AI-Compactor] Merge pass failed — joining chunk summaries with separator.');
  return chunkSummaries.join('\n\n---\n\n');
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Converts Anthropic-format messages to a compact text representation
 * suitable for feeding to the summarizer model.
 *
 * Tool outputs are capped at COMPACTION_TOOL_OUTPUT_MAX_CHARS so that even
 * large file reads don't bloat the summarizer's input beyond its useful range.
 */
function formatMessagesForSummary(messages: any[]): string {
  return messages.map(msg => {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
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
          // Cap tool output — we need key facts, not a full replay.
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
  const prompt = `You are a conversation memory optimizer. Below is a section of a technical coding conversation.

TASK:
Summarize these turns into a concise "Memory Block" (max 300 words).

CRITICAL INSTRUCTIONS:
1. For tool outputs: extract the key fact (e.g. "Read returned 142 lines from lib/auth.ts showing JWT validation logic" not "tool returned data").
2. Preserve all file paths, function names, error messages, and constants mentioned.
3. If a tool failed, note why based on the output.
4. Ignore ping/keep-alive messages.

CONVERSATION:
${historyText}

MEMORY BLOCK:`;

  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens,
      temperature: 0.3,
    },
  };
}

async function mergeSummaries(
  summaries: string[],
  apiKey: string,
  model: string
): Promise<string | null> {
  const combined = summaries
    .map((s, i) => `[Section ${i + 1}]\n${s}`)
    .join('\n\n');

  const prompt = `You are given ${summaries.length} consecutive summaries from the same coding session.
Merge them into one cohesive Memory Block (max 400 words).
Preserve all file paths, error messages, constants, and technical decisions.
Do not repeat yourself — consolidate duplicate information.

${combined}

MERGED MEMORY BLOCK:`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 700, temperature: 0.2 },
  };

  return callGeminiForCompaction(model, body, apiKey);
}
