import { redis } from './redis';

export const DEFAULT_MODEL_ROUTING = {
  "claude-opus-4-5-20251101":    { "primary": "gemini-3.1-flash-lite-preview",   "fallback": ["gemini-3-flash-preview", "gemini-2.5-flash"] },
  "claude-sonnet-4-5-20250929":  { "primary": "gemini-3.1-flash-lite-preview",   "fallback": ["gemini-3-flash-preview", "gemini-2.5-flash"] },
  "claude-haiku-4-5-20251001":   { "primary": "gemini-2.5-flash-lite", "fallback": ["gemini-2.5-flash", "gemini-flash-lite-latest"] },
  "claude-opus-4":    { "primary": "gemini-3.1-flash-lite-preview",   "fallback": ["gemma-4-31b-it", "gemini-2.5-flash"] },
  "claude-sonnet-4":  { "primary": "gemini-3.1-flash-lite-preview",   "fallback": ["gemma-4-26b-a4b-it", "gemini-2.5-flash"] },
  "claude-haiku":     { "primary": "gemini-2.5-flash-lite", "fallback": ["gemini-2.5-flash", "gemini-flash-lite-latest"] },
  
  "gemma-4-31b-it": { "primary": "gemma-4-31b-it", "fallback": ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash"] },
  "gemma-4-26b-a4b-it": { "primary": "gemma-4-26b-a4b-it", "fallback": ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash"] },
  "gemini-2.5-flash-lite": { "primary": "gemini-2.5-flash-lite", "fallback": ["gemini-flash-lite-latest", "gemini-2.5-flash"] },
  "gemini-2.5-flash": { "primary": "gemini-2.5-flash", "fallback": ["gemini-flash-latest", "gemini-3-flash-preview"] },
  "gemini-3.1-flash-lite-preview": { "primary": "gemini-3.1-flash-lite-preview", "fallback": ["gemini-3-flash-preview", "gemini-2.5-flash"] },
  "gemini-flash-latest": { "primary": "gemini-flash-latest", "fallback": ["gemini-2.5-flash"] },
  "gemini-flash-lite-latest": { "primary": "gemini-flash-lite-latest", "fallback": ["gemini-2.5-flash-lite"] },
  "gemini-3-flash-preview": { "primary": "gemini-3-flash-preview", "fallback": ["gemini-2.5-flash", "gemini-flash-latest"] }
};

export async function getModelMapping(anthropicModel: string) {
  const registryStr = await redis.get<string>('models:registry');
  let registry = DEFAULT_MODEL_ROUTING;
  if (registryStr && typeof registryStr === 'string') {
    try {
      registry = JSON.parse(registryStr);
    } catch(e) {}
  } else if (registryStr && typeof registryStr === 'object') {
    registry = registryStr;
  }

  // Exact match
  if (registry[anthropicModel as keyof typeof registry]) {
    return registry[anthropicModel as keyof typeof registry];
  }

  // Prefix match
  for (const [key, val] of Object.entries(registry)) {
    if (anthropicModel.startsWith(key)) {
      return val;
    }
  }

  let defaultFallback: string | string[] = process.env.FALLBACK_MODEL || 'gemini-2.5-flash';
  if (typeof defaultFallback === 'string' && defaultFallback.includes(',')) {
    defaultFallback = defaultFallback.split(',').map(s => s.trim());
  }

  // Default fallback
  return {
    primary: process.env.DEFAULT_MODEL || 'gemini-3.1-flash-lite-preview',
    fallback: defaultFallback
  };
}
