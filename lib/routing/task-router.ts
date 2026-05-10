import { detectIntent } from '../agent/intent-detector';

export type TaskType =
  | 'REASONING'
  | 'HEAVY_CODING'
  | 'LIGHT_CODING'
  | 'CHAT'
  | 'HEALTH_CHECK'
  | 'COMPACTION'
  | 'WEB_SEARCH';

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

/** Web search tasks → fast model to avoid compounding latency */
const WEB_SEARCH_CHAIN = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-flash-latest',
];

// ---------------------------------------------------------------------------
// Behavioral signal extraction
// ---------------------------------------------------------------------------

export interface BehavioralSignals {
  /** Number of tools defined in the request */
  toolCount: number;
  /** Number of unique tool types (diversity) */
  toolVariety: number;
  /** Code density: number of code blocks + file paths + stack traces detected */
  codeDensity: number;
  /** Execution density: bash/write/edit operations */
  executionDensity: number;
  /** Multi-file signal: references to multiple distinct files */
  multiFile: boolean;
  /** Architecture signal: references to system design, schema, dependency changes */
  architectureSignal: boolean;
  /** Explicit reasoning signal: formal logic/proof patterns ONLY */
  explicitReasoning: boolean;
  /** Web search signal: request to search internet */
  webSearch: boolean;
  /** Total length of the user message */
  messageLength: number;
}

/**
 * Extract behavioral signals from the raw request body.
 * These signals drive task classification without relying on keyword guessing.
 */
export function extractBehavioralSignals(requestBody: any): BehavioralSignals {
  const tools: any[] = Array.isArray(requestBody?.tools) ? requestBody.tools : [];
  const toolCount = tools.length;

  // Count distinct tool name prefixes as a proxy for variety
  const toolNames = tools.map((t: any) =>
    (typeof t?.name === 'string' ? t.name.split('_')[0] : '')
  );
  const toolVariety = new Set(toolNames.filter(Boolean)).size;

  const text = extractLatestUserText(requestBody);

  // Code density: code fences, file path patterns (src/..., lib/..., .ts, .js etc.), stack traces
  const codeBlocks = (text.match(/```/g) ?? []).length / 2;
  const filePaths = (text.match(/\b[\w/-]+\.(ts|tsx|js|jsx|py|go|rs|java|css|json|yaml|yml|md|sh)\b/g) ?? []).length;
  const stackTraces = (text.match(/at\s+\w+\s+\(/g) ?? []).length;
  const codeDensity = Math.round(codeBlocks + filePaths + stackTraces);

  // Execution density: bash/shell commands, write/edit patterns
  const bashRefs = (text.match(/\b(npm|npx|git|bash|sh|curl|docker|kubectl|pip|yarn|pnpm|chmod|mkdir|rm|cp|mv)\b/g) ?? []).length;
  const writeOps = (text.match(/\b(write|create|edit|update|modify|delete|remove|install|deploy|run|execute)\b/gi) ?? []).length;
  const executionDensity = Math.round(bashRefs + writeOps * 0.5);

  // Multi-file: distinct file references (3+ unique files)
  const fileMatches = text.match(/\b[\w/-]+\.(ts|tsx|js|jsx|py|go|rs)\b/g) ?? [];
  const uniqueFiles = new Set(fileMatches).size;
  const multiFile = uniqueFiles >= 3;

  // Architecture signal: high-level structure changes
  const architectureSignal = /\b(architecture|schema|migration|scaffold|refactor\s+and|full[-\s]?stack|monorepo|dependency\s+change|system\s+design|database\s+design|api\s+design)\b/i.test(text);

  // Explicit reasoning: ONLY formal logic / mathematical patterns
  // Note: "analyze", "debug", "explain" are NOT reasoning — they are coding/chat tasks
  const explicitReasoning = /\b(mathematical\s+proof|formal\s+proof|deductive\s+reason|inductive\s+reason|abductive\s+reason|probabilistic\s+reason|contradiction\s+analysis|causal\s+inference|chain[- ]of[- ]thought\s+reason|bayesian\s+reason|counterfactual\s+reason|logical\s+deduction\s+proof)/i.test(text);

  // Web search signal
  const webSearch = /\b(search\s+the\s+(web|internet|online)|look\s+up\s+online|find\s+on\s+the\s+web|web\s+search|google\s+for|browse\s+for|fetch\s+from\s+url|scrape)\b/i.test(text);

  return {
    toolCount,
    toolVariety,
    codeDensity,
    executionDensity,
    multiFile,
    architectureSignal,
    explicitReasoning,
    webSearch,
    messageLength: text.length,
  };
}

/**
 * Classify task type from behavioral signals (no keyword guessing for core routing).
 * Called by classifyTaskType after trivial-chat and explicit health/compaction checks.
 */
export function classifyFromBehavior(signals: BehavioralSignals, thinkingEnabled: boolean): TaskClassification {
  // WEB_SEARCH: explicit intent to search internet
  if (signals.webSearch) {
    return { type: 'WEB_SEARCH', reason: 'web-search-signal' };
  }

  // REASONING: explicit formal logic ONLY — not "analyze code" or "think about this"
  if (signals.explicitReasoning) {
    return { type: 'REASONING', reason: 'explicit-formal-reasoning' };
  }

  // HEAVY_CODING: high behavioral signal density
  // Triggers when any of: many tools, architecture changes, multi-file, high exec density
  if (
    signals.toolCount >= 5 ||
    signals.architectureSignal ||
    signals.multiFile ||
    signals.executionDensity >= 4 ||
    (signals.toolCount >= 2 && signals.codeDensity >= 3) ||
    thinkingEnabled
  ) {
    const reason = signals.architectureSignal
      ? 'architecture-signal'
      : signals.multiFile
        ? 'multi-file-signal'
        : signals.toolCount >= 5
          ? 'high-tool-count'
          : signals.executionDensity >= 4
            ? 'high-execution-density'
            : thinkingEnabled
              ? 'thinking-enabled'
              : 'tool-and-code-density';
    return { type: 'HEAVY_CODING', reason };
  }

  // LIGHT_CODING: moderate coding signal
  if (
    signals.codeDensity >= 1 ||
    signals.toolCount >= 1 ||
    signals.executionDensity >= 1
  ) {
    return {
      type: 'LIGHT_CODING',
      reason: signals.codeDensity >= 1 ? 'code-density' : 'tool-present',
    };
  }

  // Default: HEAVY_CODING (safe fallback — better to over-provision than under)
  return { type: 'HEAVY_CODING', reason: 'default-heavy-coding' };
}

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
  // CHAT: trivial greetings/acknowledgments — must be checked FIRST
  const intent = detectIntent(requestBody);
  if (intent.intent === 'TRIVIAL_CHAT') {
    return { type: 'CHAT', reason: `trivial-chat: ${intent.reason}` };
  }

  const text = extractLatestUserText(requestBody);

  // HEALTH_CHECK: only explicit health/diagnostic requests
  if (/\b(check\s+health|health\s*check|heartbeat|diagnostic|check\s+service|system\s+status|server\s+status|verify\s+gateway)\b/i.test(text)) {
    return { type: 'HEALTH_CHECK', reason: 'health-check-keywords' };
  }

  // COMPACTION: explicit compaction triggers
  if (/compaction|compact|summarize\s+history|memory\s+compression|context\s+compression/i.test(text)) {
    return { type: 'COMPACTION', reason: 'compaction-keywords' };
  }

  // All other tasks: classify by behavioral signals
  const signals = extractBehavioralSignals(requestBody);
  return classifyFromBehavior(signals, thinkingEnabled);
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
    case 'WEB_SEARCH':
      return [...WEB_SEARCH_CHAIN];
    default:
      return [...HEAVY_CODING_CHAIN];
  }
}

