// BehaviorAuditor — orchestrates all agent-behavior checks in one call.
//
// Called from request.ts immediately before building systemInstruction.
// Returns combined guidance text (empty string = no issues detected).
// Pure, edge-runtime safe. The only side-effect is a console.warn on detection.
//
// Checks performed (in priority order, highest first):
//   1. Loop detector       — identical failed tool calls (blocks retries)
//   2. Completion gate     — premature "done" claim against failed tools
//   3. Path guard          — structural path problems in recent tool inputs
//   4. Spec validator      — unaddressed numbered requirements in system/task text

import { detectFailureLoop } from '../transformers/loop-detector';
import { classifyFailure, formatStrategy } from './retry-strategy';
import { detectPrematureCompletion } from './completion-gate';
import { inspectHistoryPaths, buildPathGuidance } from './path-guard';
import { validateSpec } from './spec-validator';

export interface BehaviorAuditResult {
  hasGuidance: boolean;
  guidance: string;
  diagnostics: {
    loopDetected: boolean;
    loopRepeats: number;
    prematureCompletion: boolean;
    pathIssues: number;
    unaddressedRequirements: number;
  };
}

export async function runBehaviorAudit(
  messages: any[],
  systemText: string,
): Promise<BehaviorAuditResult> {
  const guidanceParts: string[] = [];
  const diagnostics = {
    loopDetected: false,
    loopRepeats: 0,
    prematureCompletion: false,
    pathIssues: 0,
    unaddressedRequirements: 0,
  };

  // 1. Loop detection (highest priority — replaces previous standalone call).
  const loopResult = detectFailureLoop(messages);
  if (loopResult.detected && loopResult.diagnostics) {
    diagnostics.loopDetected = true;
    diagnostics.loopRepeats = loopResult.diagnostics.repeats;

    // Enrich with classified retry strategy for the specific failure.
    const strategy = classifyFailure(
      loopResult.diagnostics.toolName,
      loopResult.diagnostics.errorPreview,
    );
    const strategyText = formatStrategy(strategy);
    guidanceParts.push(loopResult.guidance.trimEnd() + '\n\n' + strategyText + '\n---\n');

    console.warn(
      `[behavior-auditor] loop detected: tool=${loopResult.diagnostics.toolName}` +
      ` repeats=${loopResult.diagnostics.repeats}` +
      ` class=${strategy.failureClass}`,
    );
  }

  // 2. Premature completion gate.
  const completionResult = detectPrematureCompletion(messages);
  if (completionResult.prematureCompletion) {
    diagnostics.prematureCompletion = true;
    guidanceParts.push(completionResult.guidance);
    console.warn(
      `[behavior-auditor] premature completion: failed=${completionResult.failedToolCount}` +
      ` uncertain=${completionResult.uncertainToolCount}`,
    );
  }

  // 3. Path guard — scan recent (last 20) messages to keep it cheap.
  const recentMessages = messages.slice(-20);
  const pathIssues = inspectHistoryPaths(recentMessages);
  if (pathIssues.length > 0) {
    diagnostics.pathIssues = pathIssues.length;
    const pathGuidance = buildPathGuidance(pathIssues);
    if (pathGuidance) guidanceParts.push(pathGuidance);
    console.warn(`[behavior-auditor] path issues: ${pathIssues.length}`);
  }

  // 4. Spec validator — only fires when system prompt has a numbered list.
  // Only run when systemText is non-trivial (>100 chars) to avoid false positives
  // on short single-line prompts.
  if (systemText.length > 100) {
    const specResult = validateSpec(systemText, messages);
    const unaddressed = specResult.requirements.filter(r => !r.addressed).length;
    if (unaddressed > 0) {
      diagnostics.unaddressedRequirements = unaddressed;
      if (specResult.guidance) guidanceParts.push(specResult.guidance);
    }
  }

  const guidance = guidanceParts.join('\n');
  return {
    hasGuidance: guidance.length > 0,
    guidance,
    diagnostics,
  };
}
