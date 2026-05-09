/**
 * lib/reasoning/gemma-helper.ts
 *
 * Reasoning helper powered by gemma-4-31b-it.
 * Handles structured reasoning tasks that benefit from a dedicated
 * reasoning model rather than the primary Gemini flash model.
 *
 * Tasks:
 *   - Compaction error reasoning
 *   - Dependency reasoning
 *   - Contradiction detection reasoning
 *   - Overload compaction planning
 *
 * Integrates with: overload recovery, orchestrator, compactor.
 */

import { callGemini } from '@/lib/gemini-adapter';
import { getHealthiestKeyObj } from '@/lib/key-manager';
import { redis } from '@/lib/redis';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GEMMA_MODEL = 'gemma-4-31b-it';
const REASONING_CACHE_TTL = 300; // 5 min cache for reasoning results

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReasoningResult {
  /** The reasoning output text */
  output: string;
  /** Whether reasoning succeeded */
  success: boolean;
  /** Model used */
  model: string;
  /** Latency in ms */
  latencyMs: number;
  /** Whether result was from cache */
  cached: boolean;
}

export type ReasoningTask =
  | 'compaction_error'
  | 'dependency'
  | 'contradiction'
  | 'overload_planning';

// ---------------------------------------------------------------------------
// Core reasoning API
// ---------------------------------------------------------------------------

/**
 * Execute a reasoning task using Gemma.
 * Results are cached by task type + context hash.
 */
export async function reason(
  task: ReasoningTask,
  context: string,
): Promise<ReasoningResult> {
  const cacheKey = reasoningCacheKey(task, context);

  // Check cache
  try {
    const cached = await (redis as any).get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(typeof cached === 'string' ? cached : JSON.stringify(cached));
      return { ...parsed, cached: true };
    }
  } catch { /* proceed without cache */ }

  const start = Date.now();
  const keyObj = await getHealthiestKeyObj();
  if (!keyObj) {
    return { output: '', success: false, model: GEMMA_MODEL, latencyMs: 0, cached: false };
  }

  const systemPrompt = getSystemPrompt(task);
  const body = {
    contents: [{ role: 'user', parts: [{ text: context }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.2,
    },
  };

  try {
    const res = await callGemini(GEMMA_MODEL, keyObj.key, body, false);
    if (!res.ok) {
      return { output: '', success: false, model: GEMMA_MODEL, latencyMs: Date.now() - start, cached: false };
    }
    const json = await res.json();
    const output = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const result: ReasoningResult = {
      output,
      success: true,
      model: GEMMA_MODEL,
      latencyMs: Date.now() - start,
      cached: false,
    };

    // Cache result
    try {
      await (redis as any).set(cacheKey, JSON.stringify(result), { ex: REASONING_CACHE_TTL });
    } catch { /* best-effort */ }

    return result;
  } catch (err) {
    console.warn('[GemmaHelper] Reasoning failed:', err);
    return { output: '', success: false, model: GEMMA_MODEL, latencyMs: Date.now() - start, cached: false };
  }
}

// ---------------------------------------------------------------------------
// Task-specific reasoning
// ---------------------------------------------------------------------------

/**
 * Analyze a compaction error and suggest recovery.
 */
export async function reasonCompactionError(
  errorMessage: string,
  compactionContext: string,
): Promise<ReasoningResult> {
  return reason('compaction_error', `Error: ${errorMessage}\n\nContext:\n${compactionContext}`);
}

/**
 * Analyze dependencies between tasks or files.
 */
export async function reasonDependencies(
  taskDescriptions: string[],
): Promise<ReasoningResult> {
  const context = taskDescriptions.map((d, i) => `Task ${i + 1}: ${d}`).join('\n');
  return reason('dependency', context);
}

/**
 * Detect contradictions in context or instructions.
 */
export async function reasonContradictions(
  statements: string[],
): Promise<ReasoningResult> {
  const context = statements.map((s, i) => `Statement ${i + 1}: ${s}`).join('\n');
  return reason('contradiction', context);
}

/**
 * Plan message compaction for overload recovery.
 * Determines which messages to keep/discard to reduce token pressure.
 */
export async function planOverloadCompaction(
  messageDescriptions: string[],
  tokenBudget: number,
): Promise<ReasoningResult> {
  const context = `Token budget: ${tokenBudget}\n\nMessages:\n` +
    messageDescriptions.map((m, i) => `${i + 1}. ${m}`).join('\n');
  return reason('overload_planning', context);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getSystemPrompt(task: ReasoningTask): string {
  switch (task) {
    case 'compaction_error':
      return `You are a compaction error analyst. Analyze the error and context, then:
1. Identify the root cause
2. Suggest specific recovery steps
3. Rate severity (low/medium/high)
Keep your response concise and actionable.`;

    case 'dependency':
      return `You are a dependency analyst. Given a set of tasks:
1. Identify dependency relationships (which tasks must complete before others)
2. Flag circular dependencies
3. Suggest optimal execution order
4. Identify tasks that can run in parallel
Format: JSON with "order", "parallel_groups", and "warnings" fields.`;

    case 'contradiction':
      return `You are a contradiction detector. Given a set of statements:
1. Identify any contradictions between statements
2. Rate confidence of each contradiction (low/medium/high)
3. Suggest which statement is likely correct
Keep your response structured and concise.`;

    case 'overload_planning':
      return `You are a context compaction planner. Given a list of messages and a token budget:
1. Identify which messages are essential (must keep)
2. Identify which messages can be summarized
3. Identify which messages can be dropped
4. Ensure the kept + summarized messages fit within the token budget
Format: JSON with "keep", "summarize", and "drop" arrays of message indices.`;
  }
}

function reasoningCacheKey(task: ReasoningTask, context: string): string {
  const hash = require('crypto')
    .createHash('sha256')
    .update(`${task}:${context}`)
    .digest('hex')
    .slice(0, 16);
  return `reasoning:cache:${task}:${hash}`;
}
