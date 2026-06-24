/**
 * lib/agent/subagent-executor.ts
 *
 * Real subagent execution engine.
 * Each SubagentTask is sent to its assigned Gemini/Gemma model as a scoped
 * API call.  Handles token budgeting, retry with model rerouting, and
 * performance tracking.
 */

import { callGemini } from '@/lib/gemini-adapter';
import { getHealthiestKeyObj } from '@/lib/key-manager';
import { updateSubagentStatus, type SubagentTask } from './subagent-memory';
import { recordSubagentPerformance } from './subagent-performance';

// ---------------------------------------------------------------------------
// Token budgets per subagent role
// ---------------------------------------------------------------------------

type SubagentRole = 'PLANNER' | 'CODER' | 'VERIFIER' | 'MERGER' | 'GENERIC';

const TOKEN_BUDGET: Record<SubagentRole, number> = {
  PLANNER: 1024,
  CODER: 4096,
  VERIFIER: 2048,
  MERGER: 2048,
  GENERIC: 2048,
};

function detectRole(description: string): SubagentRole {
  const d = description.toLowerCase();
  if (d.includes('plan') || d.includes('decompose') || d.includes('coordinator')) return 'PLANNER';
  if (d.includes('cod') || d.includes('implement') || d.includes('execut')) return 'CODER';
  if (d.includes('verif') || d.includes('check') || d.includes('validat')) return 'VERIFIER';
  if (d.includes('merge') || d.includes('combine') || d.includes('integrat')) return 'MERGER';
  return 'GENERIC';
}

// ---------------------------------------------------------------------------
// Fallback model chain per primary (Phase 4: overload-aware priority)
// ---------------------------------------------------------------------------

/**
 * Phase 4 overload priority chain.
 * When a model returns overloaded_error, skip immediately to the next model.
 * Priority: gemini-2.5-flash → gemini-3-flash-preview → gemini-3.1-flash-lite-preview → gemma-4-31b-it
 */
const FALLBACK_CHAIN: Record<string, string[]> = {
  'gemma-4-31b-it': ['gemma-4-26b-a4b-it', 'gemini-2.5-flash', 'gemini-3-flash-preview'],
  'gemma-4-26b-a4b-it': ['gemma-4-31b-it', 'gemini-2.5-flash'],
  'gemini-2.5-flash': ['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview', 'gemma-4-31b-it'],
  'gemini-2.5-flash-lite': ['gemini-2.5-flash', 'gemini-3-flash-preview'],
  'gemini-3-flash-preview': ['gemini-3.1-flash-lite-preview', 'gemini-2.5-flash'],
};

function getFallbackChain(model: string): string[] {
  return FALLBACK_CHAIN[model] ?? ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemma-4-31b-it'];
}

/**
 * Phase 4: Detect overload errors so we can skip immediately to fallback
 * without incurring retry delays.
 */
function isOverloadError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('overloaded') ||
    m.includes('overload_error') ||
    m.includes('resource_exhausted') ||
    m.includes('503') ||
    m.includes('rate limit') ||
    m.includes('quota exceeded')
  );
}

// ---------------------------------------------------------------------------
// Phase 5: Concurrency semaphore (MAX_ACTIVE = 3)
// ---------------------------------------------------------------------------

const MAX_ACTIVE_EXECUTIONS = Number(process.env.SUBAGENT_MAX_ACTIVE || 3);
let _activeExecutions = 0;
const _executionQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (_activeExecutions < MAX_ACTIVE_EXECUTIONS) {
      _activeExecutions++;
      resolve();
    } else {
      _executionQueue.push(() => {
        _activeExecutions++;
        resolve();
      });
    }
  });
}

function releaseSlot(): void {
  const next = _executionQueue.shift();
  if (next) {
    next();
  } else {
    _activeExecutions = Math.max(0, _activeExecutions - 1);
  }
}

// ---------------------------------------------------------------------------
// Scoped prompt builder
// ---------------------------------------------------------------------------

function buildSubagentPrompt(task: SubagentTask, dependencyOutputs: Map<string, string>): object {
  const role = detectRole(task.description);
  const tokenBudget = TOKEN_BUDGET[role];

  // Collect dependency context
  const depContext =
    dependencyOutputs.size > 0
      ? [...dependencyOutputs.entries()]
          .map(([id, out]) => `### Output from task ${id}:\n${out}`)
          .join('\n\n')
      : '';

  const systemPrompt =
    `You are a specialized ${role.toLowerCase()} subagent.\n` +
    `Task: ${task.description}\n` +
    (depContext ? `\nDependency context:\n${depContext}\n` : '') +
    `\nBe concise. Token budget: ${tokenBudget} output tokens.`;

  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: systemPrompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: tokenBudget,
      temperature: role === 'PLANNER' ? 0.2 : 0.4,
    },
  };
}

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

export interface SubagentExecutionResult {
  taskId: string;
  model: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retries: number;
  success: boolean;
  error?: string;
}

function isEmptySubagentResult(data: any, output: string, outputTokens: number): boolean {
  const trimmed = (output || '').trim();
  if (trimmed.length > 0) return false;
  if (outputTokens > 0) return false;
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return true;
  const hasSignal = parts.some((p: any) => {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.text === 'string' && p.text.trim().length > 0) return true;
    if (p.functionCall) return true;
    return false;
  });
  return !hasSignal;
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

/**
 * Execute a single subagent task against its assigned model.
 * Retries with model fallback on failure.
 * Phase 4: Immediately skips overloaded models rather than retrying.
 * Phase 5: Acquires a concurrency slot (MAX=3) before executing.
 * Updates subagent-memory status throughout.
 */
export async function executeSubagent(
  task: SubagentTask,
  dependencyOutputs: Map<string, string> = new Map()
): Promise<SubagentExecutionResult> {
  await acquireSlot();
  const startTime = Date.now();
  const models = [task.model, ...getFallbackChain(task.model)];
  let lastError = '';
  let retries = 0;

  await updateSubagentStatus(task.id, 'RUNNING').catch(() => {});

  for (const model of models) {
    try {
      const keyObj = await getHealthiestKeyObj();
      if (!keyObj) {
        throw new Error('No API keys available');
      }

      const body = buildSubagentPrompt(task, dependencyOutputs);
      const res = await callGemini(model, keyObj.key, body, false);

      if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown error');
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const output = extractGeminiText(data);
      const inputTokens = data?.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = data?.usageMetadata?.candidatesTokenCount ?? 0;
      const latencyMs = Date.now() - startTime;

      // Phase 5 — Empty agent result detection.
      // 0-token/empty payload is treated as failure so we can fallback/retry.
      if (isEmptySubagentResult(data, output, outputTokens)) {
        throw new Error('EMPTY_SUBAGENT_RESULT');
      }

      await updateSubagentStatus(task.id, 'COMPLETED', []).catch(() => {});

      // Record performance
      await recordSubagentPerformance({
        model,
        taskType: detectRole(task.description),
        latencyMs,
        inputTokens,
        outputTokens,
        success: true,
      }).catch(() => {});

      releaseSlot();
      return {
        taskId: task.id,
        model,
        output,
        inputTokens,
        outputTokens,
        latencyMs,
        retries,
        success: true,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      retries++;
      console.warn(
        `[SubagentExecutor] task=${task.id} model=${model} attempt=${retries} error=${lastError}`
      );

      // Record the failure
      const isOverload = isOverloadError(lastError);
      await recordSubagentPerformance({
        model,
        taskType: detectRole(task.description),
        latencyMs: Date.now() - startTime,
        inputTokens: 0,
        outputTokens: 0,
        success: false,
      }).catch(() => {});

      if (isOverload) {
        console.warn(`[SubagentExecutor] task=${task.id} model=${model} OVERLOADED — skipping to next model immediately`);
      }
    }
  }

  // All models failed
  await updateSubagentStatus(task.id, 'FAILED').catch(() => {});
  releaseSlot();

  return {
    taskId: task.id,
    model: task.model,
    output: '',
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: Date.now() - startTime,
    retries,
    success: false,
    error: lastError,
  };
}

// ---------------------------------------------------------------------------
// Helper: extract text from Gemini non-streaming response
// ---------------------------------------------------------------------------

function extractGeminiText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const candidates = Array.isArray(d.candidates) ? d.candidates : [];
  const first = candidates[0] as Record<string, unknown> | undefined;
  if (!first) return '';
  const content = first.content as Record<string, unknown> | undefined;
  if (!content) return '';
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((p: unknown) =>
      p && typeof p === 'object' && typeof (p as Record<string, unknown>).text === 'string'
        ? (p as Record<string, unknown>).text
        : ''
    )
    .join('');
}
