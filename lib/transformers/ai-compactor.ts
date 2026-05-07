import { callGemini } from '../gemini-adapter';

/**
 * Uses Gemini to generate a semantic summary of removed conversation turns.
 */
export async function generateSemanticSummary(
  removedMessages: any[],
  apiKey: string,
  model: string = 'gemma-4-31b-it'
): Promise<string | null> {
  if (!removedMessages || removedMessages.length === 0) return null;

  // Format messages for the summarizer model
  const historyText = removedMessages.map(msg => {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    let content = "";
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map((b: any) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') return `[Action: ${b.name}]`;
        if (b.type === 'tool_result') {
          const resultStr = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          // Allow up to 15,000 characters for Gemma 4 to analyze (approx 4k tokens)
          return `[Tool Output: ${resultStr.length > 15000 ? resultStr.slice(0, 15000) + '... (truncated for summary)' : resultStr}]`;
        }
        return `[${b.type}]`;
      }).join(' ');
    }
    return `${role}: ${content}`;
  }).join('\n\n');

  const prompt = `You are a conversation memory optimizer. Below is a middle section of a technical conversation.
It contains large data outputs from tools (logs, file contents, command results).

TASK:
Summarize these turns into a concise "Memory Block" (max 300 words).

CRITICAL INSTRUCTIONS:
1. For LARGE tool outputs, do not just say "tool returned data". Analyze the data and explain what it means (e.g., "The logs show a null pointer at line 42" or "The search returned 5 files, only index.ts was relevant").
2. Preserve all technical decisions, file paths, and specific constants mentioned.
3. If a tool failed, explain why based on the output.

CONVERSATION TO SUMMARIZE:
${historyText}

SUMMARY:`;

  const body = {
    contents: [{
      role: 'user',
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      maxOutputTokens: 500,
      temperature: 0.3,
    }
  };

  try {
    const res = await callGemini(model, apiKey, body, false);
    if (!res.ok) {
      console.warn(`[AI-Compactor] Summarization failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    // Find the first text part, as reasoning models might return 'thought' parts first
    const textPart = parts.find((p: any) => p && typeof p.text === 'string' && p.text.trim());
    const summary = textPart?.text;
    return summary ? summary.trim() : null;
  } catch (error) {
    console.error('[AI-Compactor] Error during summarization:', error);
    return null;
  }
}

/**
 * Merges multiple sequential chunk summaries into one cohesive Memory Block.
 * Returns null if the AI call fails so the caller can fall back to concatenation.
 */
async function mergeSummaries(
  summaries: string[],
  apiKey: string,
  model: string
): Promise<string | null> {
  const combined = summaries
    .map((s, i) => `[Section ${i + 1}]\n${s}`)
    .join('\n\n');

  const prompt = `You are given ${summaries.length} consecutive conversation summaries from the same session.
Merge them into one cohesive Memory Block (max 400 words).
Preserve all file paths, error messages, constants, and technical decisions.
Do not repeat yourself — consolidate duplicate information.

${combined}

MERGED SUMMARY:`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 700,
      temperature: 0.2,
    },
  };

  try {
    const res = await callGemini(model, apiKey, body, false);
    if (!res.ok) {
      console.warn(`[AI-Compactor] Merge summarization failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p: any) => p && typeof p.text === 'string' && p.text.trim());
    const merged = textPart?.text;
    return merged ? merged.trim() : null;
  } catch (error) {
    console.error('[AI-Compactor] Error during merge summarization:', error);
    return null;
  }
}

/**
 * Splits `messages` into chunks of at most `chunkSize`, generates a semantic
 * summary for each chunk, then merges all chunk summaries into one final
 * Memory Block using a second AI pass.
 *
 * Falls back gracefully:
 *   - If a chunk call fails → that chunk is skipped (heuristic fallback in
 *     compaction.ts will fill the gap).
 *   - If the merge call fails → chunk summaries are joined with a separator.
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

  // ── 2. Summarize each chunk in PARALLEL with a per-chunk timeout ─────────
  // A slow or rate-limited Gemma call can hang for up to 60s (adapter timeout).
  // Racing with a 15s timer ensures the heuristic fallback kicks in quickly.
  const CHUNK_TIMEOUT_MS = Number(process.env.COMPACTION_CHUNK_TIMEOUT_MS || 15000);

  const summaryPromises = chunks.map((chunk, idx) =>
    Promise.race([
      generateSemanticSummary(chunk, apiKey, model),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CHUNK_TIMEOUT_MS))
    ]).then(summary => ({ summary, idx }))
  );

  const results = await Promise.all(summaryPromises);
  const chunkSummaries: string[] = results
    .sort((a, b) => a.idx - b.idx)
    .map(r => r.summary)
    .filter((s): s is string => !!s);

  if (chunkSummaries.length < chunks.length) {
    console.warn(`[AI-Compactor] ${chunks.length - chunkSummaries.length} chunk(s) timed out or failed — using heuristic for those.`);
  }

  if (chunkSummaries.length === 0) return null;

  // Skip the merge pass for 1–2 chunks — concatenation is equivalent quality
  // and saves an entire extra LLM round-trip (~2–5s).
  if (chunkSummaries.length <= 2) {
    return chunkSummaries.join('\n\n---\n\n');
  }

  // ── 3. Merge multiple chunk summaries into one Memory Block ───────────────
  const merged = await mergeSummaries(chunkSummaries, apiKey, model);
  if (merged) return merged;

  // Fallback: join with separator when the merge call fails
  console.warn('[AI-Compactor] Merge pass failed — joining chunk summaries with separator.');
  return chunkSummaries.join('\n\n---\n\n');
}
