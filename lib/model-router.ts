import { redis } from './redis';

const CLAUDE_HIGH_CAPABILITY_CHAIN = [
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
];

const CLAUDE_BALANCED_CHAIN = [
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
];

const CLAUDE_FAST_CHAIN = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
];

export const DEFAULT_MODEL_ROUTING: Record<string, { primary: string; fallback: string[] }> = {
  // --- Claude 4.5 / 4 / 3.7 (Ultra/High Capability) ---
  "claude-opus-4-5-20251101":    { "primary": CLAUDE_HIGH_CAPABILITY_CHAIN[0], "fallback": CLAUDE_HIGH_CAPABILITY_CHAIN.slice(1) },
  "claude-sonnet-4-5-20250929":  { "primary": CLAUDE_BALANCED_CHAIN[0], "fallback": CLAUDE_BALANCED_CHAIN.slice(1) },
  "claude-opus-4":               { "primary": CLAUDE_HIGH_CAPABILITY_CHAIN[0], "fallback": CLAUDE_HIGH_CAPABILITY_CHAIN.slice(1) },
  "claude-3-7-sonnet":           { "primary": CLAUDE_BALANCED_CHAIN[0], "fallback": CLAUDE_BALANCED_CHAIN.slice(1) },
  "claude-3-5-sonnet":           { "primary": CLAUDE_BALANCED_CHAIN[0], "fallback": CLAUDE_BALANCED_CHAIN.slice(1) },
  
  // --- Claude 4 / 4.6 (Next-Gen Sonnet) ---
  "claude-sonnet-4-6":           { "primary": CLAUDE_BALANCED_CHAIN[0], "fallback": CLAUDE_BALANCED_CHAIN.slice(1) },
  "claude-sonnet-4":             { "primary": CLAUDE_BALANCED_CHAIN[0], "fallback": CLAUDE_BALANCED_CHAIN.slice(1) },

  // --- Claude Haiku (Fast/Efficient) ---
  "claude-haiku-4-5-20251001":   { "primary": CLAUDE_FAST_CHAIN[0], "fallback": CLAUDE_FAST_CHAIN.slice(1) },
  "claude-haiku-4":              { "primary": CLAUDE_FAST_CHAIN[0], "fallback": CLAUDE_FAST_CHAIN.slice(1) },
  "claude-haiku":                { "primary": CLAUDE_FAST_CHAIN[0], "fallback": CLAUDE_FAST_CHAIN.slice(1) },
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

function buildClaudeDefaultRoute() {
  return {
    primary: CLAUDE_BALANCED_CHAIN[0],
    fallback: CLAUDE_BALANCED_CHAIN.slice(1),
  };
}

export async function getModelMapping(anthropicModel: string) {
  const normalizedModel = normalizeModelName(anthropicModel);

  // Allow runtime overrides via Redis
  const registryStr = await redis.get<string>('models:registry');
  let registry = DEFAULT_MODEL_ROUTING;
  if (registryStr) {
    try {
      const parsed = typeof registryStr === 'string' ? JSON.parse(registryStr) : registryStr;
      registry = { ...DEFAULT_MODEL_ROUTING, ...parsed };
    } catch(e) {}
  }

  // Exact match
  if (registry[normalizedModel]) {
    return registry[normalizedModel];
  }

  // Prefix match (e.g. "claude-3-5-sonnet-latest" -> "claude-3-5-sonnet")
  for (const [key, val] of Object.entries(registry)) {
    if (normalizedModel.startsWith(normalizeModelName(key))) {
      return val;
    }
  }

  // Unknown Claude models
  if (normalizedModel.startsWith('claude-')) {
    return buildClaudeDefaultRoute();
  }

  // Global Default
  let defaultFallback: string | string[] = process.env.FALLBACK_MODEL || 'gemini-2.5-flash';
  if (typeof defaultFallback === 'string' && defaultFallback.includes(',')) {
    defaultFallback = defaultFallback.split(',').map(s => s.trim());
  }

  return {
    primary: process.env.DEFAULT_MODEL || 'gemini-3.1-flash-lite-preview',
    fallback: defaultFallback
  };
}
