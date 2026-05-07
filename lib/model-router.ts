import { redis } from './redis';

// HIGH_CAPABILITY: strongest non-lite model first — Opus-class requests need best results.
// gemini-3-flash-preview is the newest/most capable in our allowed set.
const CLAUDE_HIGH_CAPABILITY_CHAIN = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview',
];

// BALANCED: gemini-2.5-flash is the most stable workhorse for Sonnet-class.
const CLAUDE_BALANCED_CHAIN = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

// FAST: lightest models first — Haiku-class (quick tool pings, title gen, etc.).
const CLAUDE_FAST_CHAIN = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
];

// REASONING: best reasoning first — thinking-enabled or analysis-heavy prompts.
const CLAUDE_REASONING_CHAIN = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview',
];

// TOOL: gemini-2.5-flash has the most reliable structured JSON / function-call output.
// Critical for long coding sessions with many agentic tool loops.
const CLAUDE_TOOL_CHAIN = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

// LONG_CONTEXT: gemini-3.1-flash-lite-preview supports 131k output tokens —
// the only model in the set that can write large diffs without truncation.
const CLAUDE_LONG_CONTEXT_CHAIN = [
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
];

export interface ModelRoute {
  primary: string;
  fallback: string[];
  profile?: 'simple' | 'balanced' | 'complex' | 'agentic';
  reason?: string;
  estimatedInputTokens?: number;
}

export interface ModelRoutingOptions {
  thinkingEnabled?: boolean;
  requestBody?: any;
  userId?: string;
}

export const DEFAULT_MODEL_ROUTING: Record<string, ModelRoute> = {
  // --- Claude 4 Series (Next-Gen) ---
  "claude-4-7-opus":             { "primary": CLAUDE_HIGH_CAPABILITY_CHAIN[0], "fallback": CLAUDE_HIGH_CAPABILITY_CHAIN.slice(1) },
  "claude-4-6-sonnet":           { "primary": CLAUDE_BALANCED_CHAIN[0], "fallback": CLAUDE_BALANCED_CHAIN.slice(1) },
  "claude-4-5-haiku":            { "primary": CLAUDE_FAST_CHAIN[0], "fallback": CLAUDE_FAST_CHAIN.slice(1) },
  "claude-4-5-opus":             { "primary": CLAUDE_HIGH_CAPABILITY_CHAIN[0], "fallback": CLAUDE_HIGH_CAPABILITY_CHAIN.slice(1) },
  "claude-4-opus":               { "primary": CLAUDE_HIGH_CAPABILITY_CHAIN[0], "fallback": CLAUDE_HIGH_CAPABILITY_CHAIN.slice(1) },
  "claude-4-sonnet":             { "primary": CLAUDE_BALANCED_CHAIN[0], "fallback": CLAUDE_BALANCED_CHAIN.slice(1) },
  "claude-4-haiku":              { "primary": CLAUDE_FAST_CHAIN[0], "fallback": CLAUDE_FAST_CHAIN.slice(1) },

  // --- Claude 3.7 / 3.5 (Legacy/Current) ---
  "claude-3-7-sonnet":           { "primary": CLAUDE_BALANCED_CHAIN[0], "fallback": CLAUDE_BALANCED_CHAIN.slice(1) },
  "claude-3-5-sonnet":           { "primary": CLAUDE_BALANCED_CHAIN[0], "fallback": CLAUDE_BALANCED_CHAIN.slice(1) },
  "claude-3-5-haiku":            { "primary": CLAUDE_FAST_CHAIN[0], "fallback": CLAUDE_FAST_CHAIN.slice(1) },
  "claude-3-opus":               { "primary": CLAUDE_HIGH_CAPABILITY_CHAIN[0], "fallback": CLAUDE_HIGH_CAPABILITY_CHAIN.slice(1) },
  "claude-3-haiku":              { "primary": CLAUDE_FAST_CHAIN[0], "fallback": CLAUDE_FAST_CHAIN.slice(1) },

  // --- Native Gemini & Gemma Mappings ---
  "gemma-4-31b-it": { "primary": "gemma-4-31b-it", "fallback": ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash"] },
  "gemma-4-26b-a4b-it": { "primary": "gemma-4-26b-a4b-it", "fallback": ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash"] },
  "gemini-2.5-flash-lite": { "primary": "gemini-2.5-flash-lite", "fallback": ["gemini-flash-lite-latest", "gemini-2.5-flash"] },
  "gemini-2.5-flash": { "primary": "gemini-2.5-flash", "fallback": ["gemini-flash-latest", "gemini-3-flash-preview"] },
  "gemini-3.1-flash-lite-preview": { "primary": "gemini-3.1-flash-lite-preview", "fallback": ["gemini-3-flash-preview", "gemini-2.5-flash"] },
  "gemini-flash-latest": { "primary": "gemini-flash-latest", "fallback": ["gemini-2.5-flash"] },
  "gemini-flash-lite-latest": { "primary": "gemini-flash-lite-latest", "fallback": ["gemini-2.5-flash-lite"] },
  "gemini-3-flash-preview": { "primary": "gemini-3-flash-preview", "fallback": ["gemini-2.5-flash", "gemini-flash-latest"] }
};

function normalizeModelName(rawModel: string): string {
  if (!rawModel) return rawModel;
  return rawModel.trim().toLowerCase();
}

function buildClaudeDefaultRoute(): ModelRoute {
  return {
    primary: CLAUDE_BALANCED_CHAIN[0],
    fallback: CLAUDE_BALANCED_CHAIN.slice(1),
  };
}

function dedupeChain(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of models) {
    const normalized = normalizeModelName(model);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry?.type === 'text' && typeof entry.text === 'string') return entry.text;
      if (entry?.type === 'thinking' && typeof entry.thinking === 'string') return entry.thinking;
      if (typeof entry?.text === 'string') return entry.text;
      return '';
    }).join('\n');
  }
  return '';
}

function estimateInputTokensFromRequest(requestBody: any): number {
  if (!requestBody || typeof requestBody !== 'object') return 0;
  let chars = 0;

  if (typeof requestBody.system === 'string') chars += requestBody.system.length;
  if (Array.isArray(requestBody.system)) {
    chars += requestBody.system.map((s: any) => extractText(s)).join('\n').length;
  }

  for (const msg of requestBody.messages || []) {
    chars += extractText(msg?.content).length;
  }

  if (Array.isArray(requestBody.tools)) {
    chars += JSON.stringify(requestBody.tools).length;
  }

  return Math.ceil(chars / 4);
}

function profileRequest(
  requestBody: any,
  thinkingEnabled: boolean
): {
  profile: 'simple' | 'balanced' | 'complex' | 'agentic';
  reason: string;
  estimatedInputTokens: number;
  toolCount: number;
  hasTools: boolean;
  hasImages: boolean;
} {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const estimatedInputTokens = estimateInputTokensFromRequest(requestBody);
  const toolCount = Array.isArray(requestBody?.tools) ? requestBody.tools.length : 0;
  const hasTools = toolCount > 0;
  const hasToolChoiceConstraint =
    requestBody?.tool_choice?.type === 'tool' || requestBody?.tool_choice?.type === 'any';
  const conversationTurns = messages.length;
  const maxTokens = Number(requestBody?.max_tokens || 0);

  const hasImages = messages.some((msg: any) => {
    if (!Array.isArray(msg?.content)) return false;
    return msg.content.some((block: any) =>
      block?.type === 'image' ||
      (block?.type === 'tool_result' &&
        Array.isArray(block.content) &&
        block.content.some((nested: any) => nested?.type === 'image'))
    );
  });

  let lastUserText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserText = extractText(messages[i].content).toLowerCase();
      break;
    }
  }

  let score = 0;
  const reasons: string[] = [];
  const reasoningRegex = /\b(analyze|architecture|design|debug|investigate|reason|step[- ]by[- ]step|plan|multi[- ]step)\b/i;

  if (thinkingEnabled) {
    score += 3;
    reasons.push('thinking enabled');
  }
  if (hasTools) {
    score += toolCount > 4 ? 3 : 2;
    reasons.push(`tools=${toolCount}`);
  }
  if (hasToolChoiceConstraint) {
    score += 1;
    reasons.push('tool_choice constrained');
  }
  if (hasImages) {
    score += 1;
    reasons.push('contains images');
  }
  if (estimatedInputTokens > 16000) {
    score += 2;
    reasons.push('large context');
  }
  if (estimatedInputTokens > 60000) {
    score += 2;
    reasons.push('very large context');
  }
  if (maxTokens > 8192) {
    score += 1;
    reasons.push('high output budget');
  }
  if (conversationTurns > 16) {
    score += 1;
    reasons.push('long conversation');
  }
  if (reasoningRegex.test(lastUserText)) {
    score += 2;
    reasons.push('reasoning-heavy prompt');
  }

  let profile: 'simple' | 'balanced' | 'complex' | 'agentic' = 'balanced';
  if (score <= 2) profile = 'simple';
  else if (score <= 5) profile = 'balanced';
  else if (score <= 8) profile = 'complex';
  else profile = 'agentic';

  return {
    profile,
    reason: reasons.join(', ') || 'default-balanced',
    estimatedInputTokens,
    toolCount,
    hasTools,
    hasImages,
  };
}

function chooseAdaptiveChain(profile: ReturnType<typeof profileRequest>): string[] {
  if (profile.estimatedInputTokens > 50000) return CLAUDE_LONG_CONTEXT_CHAIN;
  if (profile.profile === 'agentic') return CLAUDE_REASONING_CHAIN;
  if (profile.profile === 'complex') {
    return profile.hasTools ? CLAUDE_TOOL_CHAIN : CLAUDE_REASONING_CHAIN;
  }
  if (profile.hasTools) return CLAUDE_TOOL_CHAIN;
  if (profile.profile === 'simple' && !profile.hasImages) return CLAUDE_FAST_CHAIN;
  return CLAUDE_BALANCED_CHAIN;
}

function resolveGlobalDefaultRoute(): ModelRoute {
  const fallbackRaw = process.env.FALLBACK_MODEL || 'gemini-2.5-flash';
  const fallback = fallbackRaw.includes(',')
    ? fallbackRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [fallbackRaw];
  return {
    primary: process.env.DEFAULT_MODEL || 'gemini-3.1-flash-lite-preview',
    fallback,
  };
}

async function readRegistry(): Promise<Record<string, ModelRoute>> {
  const registryStr = await redis.get<string>('models:registry');
  if (!registryStr) return DEFAULT_MODEL_ROUTING;

  try {
    const parsed = typeof registryStr === 'string' ? JSON.parse(registryStr) : registryStr;
    return { ...DEFAULT_MODEL_ROUTING, ...parsed };
  } catch {
    return DEFAULT_MODEL_ROUTING;
  }
}

function resolveBaseRoute(
  normalizedModel: string,
  registry: Record<string, ModelRoute>
): ModelRoute {
  if (registry[normalizedModel]) {
    return {
      primary: normalizeModelName(registry[normalizedModel].primary),
      fallback: dedupeChain(registry[normalizedModel].fallback || []),
    };
  }

  for (const [key, value] of Object.entries(registry)) {
    if (normalizedModel.startsWith(normalizeModelName(key))) {
      return {
        primary: normalizeModelName(value.primary),
        fallback: dedupeChain(value.fallback || []),
      };
    }
  }

  if (normalizedModel.startsWith('claude-')) {
    return buildClaudeDefaultRoute();
  }

  return resolveGlobalDefaultRoute();
}

export async function getModelMapping(
  anthropicModel: string,
  optionsOrThinking: boolean | ModelRoutingOptions = false
): Promise<ModelRoute> {
  const options: ModelRoutingOptions =
    typeof optionsOrThinking === 'boolean'
      ? { thinkingEnabled: optionsOrThinking }
      : optionsOrThinking;

  const normalizedModel = normalizeModelName(anthropicModel);
  const thinkingEnabled = Boolean(options.thinkingEnabled);
  
  // Parallelize Registry and Sticky model lookups to save 1 RTT (approx 20-50ms)
  const [registry, stickyRaw] = await Promise.all([
    readRegistry(),
    options.userId 
      ? redis.get<string>(`route:last:${options.userId}:${normalizedModel}`).catch(() => null)
      : Promise.resolve(null)
  ]);

  const baseRoute = resolveBaseRoute(normalizedModel, registry);

  if (!normalizedModel.startsWith('claude-')) {
    const chain = dedupeChain([baseRoute.primary, ...baseRoute.fallback]);
    return {
      primary: chain[0] || resolveGlobalDefaultRoute().primary,
      fallback: chain.slice(1),
    };
  }

  const profile = profileRequest(options.requestBody, thinkingEnabled);
  const adaptiveChain = thinkingEnabled
    ? CLAUDE_REASONING_CHAIN
    : chooseAdaptiveChain(profile);

  let stickyModel = '';
  if (typeof stickyRaw === 'string' && stickyRaw.trim()) {
    stickyModel = normalizeModelName(stickyRaw);
  }

  const finalChain = dedupeChain([
    stickyModel,
    ...adaptiveChain,
    baseRoute.primary,
    ...baseRoute.fallback,
    ...CLAUDE_HIGH_CAPABILITY_CHAIN,
  ]);

  return {
    primary: finalChain[0] || baseRoute.primary,
    fallback: finalChain.slice(1),
    profile: profile.profile,
    reason: profile.reason,
    estimatedInputTokens: profile.estimatedInputTokens,
  };
}
