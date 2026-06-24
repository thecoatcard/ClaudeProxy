import { getCapabilityProfile } from '../models/capability-profile';

export interface AdaptiveGuidancePolicy {
  strength: 'light' | 'strong';
}

export function getAdaptiveGuidancePolicy(model?: string): AdaptiveGuidancePolicy {
  const profile = getCapabilityProfile(model);
  const average = (
    profile.scores.tool_adherence +
    profile.scores.spec_fidelity +
    profile.scores.completion_honesty
  ) / 3;

  return { strength: average >= 0.75 ? 'light' : 'strong' };
}

export function buildAdaptiveBehaviorReminder(model: string | undefined, hasIssues: boolean): string {
  if (!hasIssues) return '';

  const policy = getAdaptiveGuidancePolicy(model);
  if (policy.strength === 'light') {
    return '[POLICY] Verify last tool result before the next action. Use the smallest corrective step.';
  }
  return '[POLICY] Verify assumptions from last result. Change plan or args before any retry. Confirm success before claiming completion.';
}
