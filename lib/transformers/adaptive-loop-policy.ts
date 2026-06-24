import { getCapabilityProfile } from '../models/capability-profile';

export interface AdaptiveLoopPolicy {
  minRepeats: number;
  guidanceStrength: 'light' | 'strong';
  extraGuidance: string;
}

export function getAdaptiveLoopPolicy(model?: string): AdaptiveLoopPolicy {
  const profile = getCapabilityProfile(model);
  const { tool_adherence, retry_quality } = profile.scores;
  const weakToolModel = tool_adherence < 0.65 || retry_quality < 0.65;
  const strongToolModel = tool_adherence >= 0.82 && retry_quality >= 0.8;

  if (strongToolModel) {
    return {
      minRepeats: 3,
      guidanceStrength: 'light',
      extraGuidance: 'Use a different strategy before retrying the same failing tool call.',
    };
  }

  if (weakToolModel) {
    return {
      minRepeats: 2,
      guidanceStrength: 'strong',
      extraGuidance: [
        'Do not repeat the same failed tool call.',
        'Verify prerequisites first, then change the tool, arguments, or plan before trying again.',
      ].join(' '),
    };
  }

  return {
    minRepeats: 2,
    guidanceStrength: 'light',
    extraGuidance: 'Change the tool arguments or verify assumptions before retrying.',
  };
}
