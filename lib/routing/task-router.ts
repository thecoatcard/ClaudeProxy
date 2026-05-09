import { detectIntent } from '../agent/intent-detector';

export type TaskType =
  | 'REASONING'
  | 'HEAVY_CODING'
  | 'LIGHT_CODING'
  | 'CHAT'
  | 'HEALTH_CHECK'
  | 'COMPACTION';

export interface TaskClassification {
  type: TaskType;
  reason: string;
}

// ── ALLOWED MODEL POOL (strict) ──────────────────────────────────────────────
// Only models in this set will ever be routed to. Any model resolved outside
// this set is a bug — the pool enforcer in model-router.ts filters them out.
export const ALLOWED_MODEL_POOL = new Set<string>([
  'gemma-4-31b-it',
  'gemini-2.5-flash',
  'gemma-4-26b-a4b-it',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-3-flash-preview',
]);

// ── Per-task model chains ────────────────────────────────────────────────────
// Primary = best-fit model for the task type.
// Fallbacks = ordered by capability for graceful degradation.

/** Explicit reasoning (chain-of-thought, proof, causal analysis) → Gemma */
const REASONING_CHAIN = [
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
];

/** Large multi-file coding, architecture, full-stack work → Gemini 2.5 Flash */
const HEAVY_CODING_CHAIN = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

/** Fast, small coding tasks → Gemini 3 Flash Preview (lower latency) */
const LIGHT_CODING_CHAIN = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
];

/** Health checks → cheapest healthy model */
const HEALTH_CHECK_CHAIN = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
];

/** Quick chat / trivial responses → cheapest model */
const CHAT_CHAIN = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
];

/** Context compaction (summarise large histories) → Gemma small (efficient) */
const COMPACTION_CHAIN = [
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
  'gemini-2.5-flash',
];

function extractLatestUserText(requestBody: any): string {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    const content = messages[i]?.content;
    if (typeof content === 'string') return content.toLowerCase();
    if (Array.isArray(content)) {
      return content
        .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
        .join(' ')
        .toLowerCase();
    }
  }
  return '';
}

export function classifyTaskType(requestBody: any, thinkingEnabled = false): TaskClassification {
  const text = extractLatestUserText(requestBody);
  const toolCount = Array.isArray(requestBody?.tools) ? requestBody.tools.length : 0;

  // CHAT: trivial greetings/acknowledgments — must be checked FIRST
  const intent = detectIntent(requestBody);
  if (intent.intent === 'TRIVIAL_CHAT') {
    return { type: 'CHAT', reason: `trivial-chat: ${intent.reason}` };
  }

  // HEALTH_CHECK: only explicit health/diagnostic requests (not greetings like "ping" or "status")
  if (/\b(check\s+health|health\s*check|heartbeat|diagnostic|check\s+service|system\s+status|server\s+status|verify\s+gateway)\b/i.test(text)) {
    return { type: 'HEALTH_CHECK', reason: 'health-check-keywords' };
  }

  if (/compaction|compact|summarize\s+history|memory\s+compression|context\s+compression/i.test(text)) {
    return { type: 'COMPACTION', reason: 'compaction-keywords' };
  }

  // REASONING: explicit analytical/logical reasoning tasks → Gemma (best for chain-of-thought).
  // Use narrow, high-precision patterns — do NOT route ordinary Claude Code work to Gemma.
  // Patterns like "analyze code", "think about", "plan" are NOT reasoning — Claude Code is the agent.
  if (
    /\b(contradiction\s+analysis|root\s+cause\s+reason|causal\s+reason|logical\s+deduction|chain[- ]of[- ]thought|step[- ]by[- ]step\s+reason|mathematical\s+proof|formal\s+proof|deductive\s+reason|inductive\s+reason|abductive\s+reason|probabilistic\s+reason|counterfactual|bayesian\s+reason)\b/i.test(text)
  ) {
    return { type: 'REASONING', reason: 'explicit-reasoning-keywords' };
  }

  if (
    toolCount >= 3 ||
    /multi-file|architecture|full-stack|generate\s+.*(app|project|system)|orchestrat|refactor\s+and\s+rebuild/i.test(text)
  ) {
    return { type: 'HEAVY_CODING', reason: toolCount >= 3 ? 'high-tool-count' : 'heavy-coding-keywords' };
  }

  if (/quick fix|small fix|minor|lint|format|key validation|validate key|tiny/i.test(text)) {
    return { type: 'LIGHT_CODING', reason: 'light-coding-keywords' };
  }

  return { type: 'HEAVY_CODING', reason: thinkingEnabled ? 'thinking-enabled-heavy-coding' : 'default-heavy-coding' };
}

export function getTaskModelChain(taskType: TaskType): string[] {
  switch (taskType) {
    case 'REASONING':
      return [...REASONING_CHAIN];
    case 'HEAVY_CODING':
      return [...HEAVY_CODING_CHAIN];
    case 'LIGHT_CODING':
      return [...LIGHT_CODING_CHAIN];
    case 'CHAT':
      return [...CHAT_CHAIN];
    case 'HEALTH_CHECK':
      return [...HEALTH_CHECK_CHAIN];
    case 'COMPACTION':
      return [...COMPACTION_CHAIN];
    default:
      return [...HEAVY_CODING_CHAIN];
  }
}
