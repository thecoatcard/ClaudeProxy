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
    return '[GATEWAY MODEL POLICY] Prefer structured tool calls, verify the last result, and continue with the smallest corrective step.';
  }

  return [
    '[GATEWAY MODEL POLICY] Use structured tool calls only.',
    'Before the next action, verify assumptions from the last tool result.',
    'After each action, confirm success before claiming completion.',
    'If a tool fails, do not repeat the same call until you change the plan or arguments.',
  ].join(' ');
}
