// BehaviorAuditor — orchestrates all agent-behavior checks in one call.
//
// Called from request.ts immediately before building systemInstruction.
// Returns combined guidance text (empty string = no issues detected).
// Pure, edge-runtime safe. The only side-effect is a console.warn on detection.
//
// Checks performed (in priority order, highest first):
//   1. Loop detector           — identical failed tool calls (blocks retries)
//   2. Completion gate         — premature "done" claim against failed tools
//   3. Path guard              — structural path problems in recent tool inputs
//   4. Spec validator          — unaddressed numbered requirements in system/task text
//   5. Long-running process    — dev server startup state tracking
//   6. Interactive commands    — TTY-blocking CLI wizards
//   7. Contradiction detection — A→B→A oscillation loops
//   8. Dependency compat       — known-breaking version installs
//   9. Web recovery            — error patterns requiring official docs

import { detectFailureLoop } from '../transformers/loop-detector';
import { classifyFailure, formatStrategy } from './retry-strategy';
import { detectPrematureCompletion } from './completion-gate';
import { inspectHistoryPaths, buildPathGuidance } from './path-guard';
import { validateSpec } from './spec-validator';
import { buildAdaptiveBehaviorReminder } from '../transformers/adaptive-guidance';
import { assessLongRunningProcessHistory } from './process-supervisor';
import { detectInteractiveCommandsInHistory, buildInteractiveCommandGuidance } from './interactive-command-guard';
import { detectContradiction } from './contradiction-detector';
import { checkInstallCompatibility } from './dependency-compatibility';
import { classifyAndRecover, requiresWebSearch } from './web-recovery';

export interface BehaviorAuditResult {
  hasGuidance: boolean;
  guidance: string;
  diagnostics: {
    loopDetected: boolean;
    loopRepeats: number;
    prematureCompletion: boolean;
    pathIssues: number;
    unaddressedRequirements: number;
    longRunningProcessDetected: boolean;
    longRunningProcessState: 'STARTED' | 'FAILED' | 'UNKNOWN' | 'NONE';
    interactiveCommandsDetected: number;
    contradictionDetected: boolean;
    contradictionLoops: number;
    dependencyRisks: number;
    webRecoveryTriggered: boolean;
  };
}

export async function runBehaviorAudit(
  messages: any[],
  systemText: string,
  internalModel?: string,
): Promise<BehaviorAuditResult> {
  const guidanceParts: string[] = [];
  const diagnostics: BehaviorAuditResult['diagnostics'] = {
    loopDetected: false,
    loopRepeats: 0,
    prematureCompletion: false,
    pathIssues: 0,
    unaddressedRequirements: 0,
    longRunningProcessDetected: false,
    longRunningProcessState: 'NONE',
    interactiveCommandsDetected: 0,
    contradictionDetected: false,
    contradictionLoops: 0,
    dependencyRisks: 0,
    webRecoveryTriggered: false,
  };

  // 1. Loop detection (highest priority — replaces previous standalone call).
  const loopResult = detectFailureLoop(messages, internalModel);
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

  // 5. Long-running process supervisor — detect dev/server commands and
  // classify startup status from tool_result logs.
  const processAssessment = assessLongRunningProcessHistory(messages);
  if (processAssessment.foundLongRunningCommand) {
    diagnostics.longRunningProcessDetected = true;
    diagnostics.longRunningProcessState = processAssessment.lastAnalysis?.state || 'UNKNOWN';
    if (processAssessment.guidance) guidanceParts.push(processAssessment.guidance);
    console.warn(
      `[behavior-auditor] long-running process: state=${diagnostics.longRunningProcessState}` +
      ` env=${processAssessment.environment}`,
    );
  }

  // 6. Interactive command guard — detect wizard-style CLIs that block on TTY input.
  // Scans recent messages (last 20) to keep cost low. Only fires once per detected command.
  const interactiveDetections = detectInteractiveCommandsInHistory(messages.slice(-20));
  if (interactiveDetections.length > 0) {
    diagnostics.interactiveCommandsDetected = interactiveDetections.length;
    const interactiveGuidance = buildInteractiveCommandGuidance(interactiveDetections);
    if (interactiveGuidance) guidanceParts.push(interactiveGuidance);
    console.warn(
      `[behavior-auditor] interactive commands detected: ${interactiveDetections.map(d => d.matchedRule).join(', ')}`,
    );
  }

  const adaptiveReminder = buildAdaptiveBehaviorReminder(internalModel, guidanceParts.length > 0);
  if (adaptiveReminder) guidanceParts.push(adaptiveReminder);

  // 7. Contradiction detection — A→B→A oscillation loops.
  const contradictionResult = detectContradiction(messages);
  if (contradictionResult.detected) {
    diagnostics.contradictionDetected = true;
    diagnostics.contradictionLoops = contradictionResult.loops.length;
    if (contradictionResult.guidance) guidanceParts.push(contradictionResult.guidance);
    console.warn(
      `[behavior-auditor] contradiction loops: ${contradictionResult.loops.length} loop(s) detected`,
    );
  }

  // 8. Dependency compatibility check — scan recent install commands.
  const recentInstallCmds = extractInstallCommands(messages.slice(-30));
  for (const cmd of recentInstallCmds) {
    const compatResult = checkInstallCompatibility(cmd);
    if (compatResult.hasRisks) {
      diagnostics.dependencyRisks += compatResult.risks.length;
      if (compatResult.guidance) guidanceParts.push(compatResult.guidance);
    }
  }
  if (diagnostics.dependencyRisks > 0) {
    console.warn(`[behavior-auditor] dependency risks: ${diagnostics.dependencyRisks} package(s)`);
  }

  // 9. Web recovery — scan recent error tool results.
  const recentErrors = extractToolErrors(messages.slice(-15));
  const errorRepeatMap = buildErrorRepeatMap(messages.slice(-30));
  for (const { errorText, toolInput } of recentErrors) {
    const repeats = errorRepeatMap.get(errorText.slice(0, 80)) ?? 1;
    if (requiresWebSearch(errorText) || repeats >= 2) {
      const recoveryResult = classifyAndRecover(errorText, toolInput, repeats);
      if (recoveryResult.shouldSearch && recoveryResult.guidance) {
        diagnostics.webRecoveryTriggered = true;
        guidanceParts.push(recoveryResult.guidance);
        console.warn(
          `[behavior-auditor] web recovery triggered: class=${recoveryResult.errorClass} repeats=${repeats}`,
        );
        break; // one recovery guidance per turn is enough
      }
    }
  }

  const guidance = guidanceParts.join('\n');
  return {
    hasGuidance: guidance.length > 0,
    guidance,
    diagnostics,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractInstallCommands(messages: any[]): string[] {
  const cmds: string[] = [];
  const installRe = /(?:npm\s+install|npm\s+i|yarn\s+add|pnpm\s+add)\s+[^;|\n]{5,}/i;
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_use') continue;
      const command = typeof block.input?.command === 'string' ? block.input.command : '';
      if (installRe.test(command)) cmds.push(command.slice(0, 300));
    }
  }
  return cmds;
}

function extractToolErrors(messages: any[]): Array<{ errorText: string; toolInput?: any }> {
  const errors: Array<{ errorText: string; toolInput?: any }> = [];
  for (const msg of messages) {
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_result') continue;
      const content = Array.isArray(block.content) ? block.content : [];
      for (const part of content) {
        if (typeof part?.text === 'string' && part.text.length > 20) {
          // Check for error signals
          if (/error|failed|cannot|not found|exit code [^0]/i.test(part.text)) {
            errors.push({ errorText: part.text.slice(0, 600) });
          }
        }
      }
    }
  }
  return errors.slice(0, 5); // check at most 5 recent errors
}

function buildErrorRepeatMap(messages: any[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const { errorText } of extractToolErrors(messages)) {
    const key = errorText.slice(0, 80);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}
