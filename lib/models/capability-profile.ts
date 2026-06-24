export interface ModelCapabilityScores {
  tool_adherence: number;
  structured_output_reliability: number;
  retry_quality: number;
  spec_fidelity: number;
  completion_honesty: number;
  context_retention: number;
  compaction_tolerance: number;
}

export interface ModelCapabilityProfile {
  model: string;
  scores: ModelCapabilityScores;
}

const DEFAULT_SCORES: ModelCapabilityScores = {
  tool_adherence: 0.6,
  structured_output_reliability: 0.6,
  retry_quality: 0.6,
  spec_fidelity: 0.6,
  completion_honesty: 0.6,
  context_retention: 0.6,
  compaction_tolerance: 0.6,
};

const PROFILES: Record<string, ModelCapabilityScores> = {
  'gemini-2.5-flash': {
    tool_adherence: 0.92,
    structured_output_reliability: 0.9,
    retry_quality: 0.88,
    spec_fidelity: 0.87,
    completion_honesty: 0.81,
    context_retention: 0.86,
    compaction_tolerance: 0.86,
  },
  'gemini-2.5-flash-lite': {
    tool_adherence: 0.71,
    structured_output_reliability: 0.69,
    retry_quality: 0.66,
    spec_fidelity: 0.67,
    completion_honesty: 0.64,
    context_retention: 0.61,
    compaction_tolerance: 0.59,
  },
  'gemini-3-flash-preview': {
    tool_adherence: 0.85,
    structured_output_reliability: 0.83,
    retry_quality: 0.81,
    spec_fidelity: 0.83,
    completion_honesty: 0.77,
    context_retention: 0.8,
    compaction_tolerance: 0.79,
  },
  'gemini-3.1-flash-lite-preview': {
    tool_adherence: 0.68,
    structured_output_reliability: 0.65,
    retry_quality: 0.63,
    spec_fidelity: 0.66,
    completion_honesty: 0.62,
    context_retention: 0.74,
    compaction_tolerance: 0.72,
  },
  'gemini-flash-latest': {
    tool_adherence: 0.74,
    structured_output_reliability: 0.72,
    retry_quality: 0.7,
    spec_fidelity: 0.71,
    completion_honesty: 0.67,
    context_retention: 0.68,
    compaction_tolerance: 0.66,
  },
  'gemini-flash-lite-latest': {
    tool_adherence: 0.58,
    structured_output_reliability: 0.56,
    retry_quality: 0.54,
    spec_fidelity: 0.55,
    completion_honesty: 0.53,
    context_retention: 0.52,
    compaction_tolerance: 0.5,
  },
  'gemma-4-31b-it': {
    tool_adherence: 0.42,
    structured_output_reliability: 0.44,
    retry_quality: 0.47,
    spec_fidelity: 0.51,
    completion_honesty: 0.49,
    context_retention: 0.46,
    compaction_tolerance: 0.43,
  },
  'gemma-4-26b-a4b-it': {
    tool_adherence: 0.39,
    structured_output_reliability: 0.41,
    retry_quality: 0.44,
    spec_fidelity: 0.48,
    completion_honesty: 0.46,
    context_retention: 0.42,
    compaction_tolerance: 0.4,
  },
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function normalizeModelName(model?: string): string {
  return String(model || '').trim().toLowerCase();
}

export function getCapabilityProfile(model?: string): ModelCapabilityProfile {
  const normalized = normalizeModelName(model);
  const scores = PROFILES[normalized] || DEFAULT_SCORES;

  return {
    model: normalized || 'unknown',
    scores: {
      tool_adherence: clamp01(scores.tool_adherence),
      structured_output_reliability: clamp01(scores.structured_output_reliability),
      retry_quality: clamp01(scores.retry_quality),
      spec_fidelity: clamp01(scores.spec_fidelity),
      completion_honesty: clamp01(scores.completion_honesty),
      context_retention: clamp01(scores.context_retention),
      compaction_tolerance: clamp01(scores.compaction_tolerance),
    },
  };
}
