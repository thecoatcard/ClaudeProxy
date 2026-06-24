import type { ActionRecovery } from './action-recovery';
import { getCapabilityProfile } from '../models/capability-profile';

export interface AdaptiveActionPolicy {
  recoveryMode: 'minimal' | 'balanced' | 'aggressive';
}

export function getAdaptiveActionPolicy(model?: string): AdaptiveActionPolicy {
  const profile = getCapabilityProfile(model);
  const reliability = Math.min(
    profile.scores.tool_adherence,
    profile.scores.structured_output_reliability,
  );

  if (reliability >= 0.82) return { recoveryMode: 'minimal' };
  if (reliability <= 0.58) return { recoveryMode: 'aggressive' };
  return { recoveryMode: 'balanced' };
}

export function shouldRecoverActionText(
  model: string | undefined,
  fullText: string,
  recovered: ActionRecovery,
): boolean {
  const { recoveryMode } = getAdaptiveActionPolicy(model);
  const before = fullText.slice(0, recovered.start).trim();
  const after = fullText.slice(recovered.end).trim();
  const sideChars = before.length + after.length;

  if (recoveryMode === 'aggressive') return true;
  if (recoveryMode === 'minimal') return sideChars <= 24;

  // Balanced: recover when the action marker dominates the segment or any
  // surrounding text is short enough to treat as wrapper text.
  return sideChars <= 80 || recovered.raw.length >= Math.max(40, fullText.trim().length * 0.45);
}
