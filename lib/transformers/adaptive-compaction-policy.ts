import { getCapabilityProfile } from '../models/capability-profile';

export interface AdaptiveCompactionPolicy {
  maxTokensApprox: number;
  keepLastN: number;
  summaryCharBudget: number;
  failureAnchorDepth: number;
}

export function getAdaptiveCompactionPolicy(
  model: string | undefined,
  baseTargetTokens: number,
  baseKeepLastN: number,
  baseSummaryCharBudget: number = 3000,
): AdaptiveCompactionPolicy {
  const profile = getCapabilityProfile(model);
  const { context_retention, compaction_tolerance } = profile.scores;

  if (context_retention >= 0.8 && compaction_tolerance >= 0.78) {
    return {
      maxTokensApprox: Math.round(baseTargetTokens * 1.15),
      keepLastN: Math.max(baseKeepLastN, baseKeepLastN + 2),
      summaryCharBudget: Math.max(baseSummaryCharBudget, 2600),
      failureAnchorDepth: 2,
    };
  }

  if (context_retention <= 0.58 || compaction_tolerance <= 0.55) {
    return {
      maxTokensApprox: Math.round(baseTargetTokens * 0.82),
      keepLastN: Math.max(baseKeepLastN, baseKeepLastN + 6),
      summaryCharBudget: Math.max(baseSummaryCharBudget, 4200),
      failureAnchorDepth: 4,
    };
  }

  return {
    maxTokensApprox: baseTargetTokens,
    keepLastN: Math.max(baseKeepLastN, baseKeepLastN + 2),
    summaryCharBudget: Math.max(baseSummaryCharBudget, 3400),
    failureAnchorDepth: 3,
  };
}
