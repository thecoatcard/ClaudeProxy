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

import { detectFailureLoop, detectEditStagnation } from '../transformers/loop-detector';
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
import { verifyAllToolResults } from './verification-engine';
import {
  buildPlatformShellGuidance,
  buildPythonPatchValidationGuidance,
  detectPlatformShellPatchRisks,
  detectPythonPatchValidationRisks,
} from './tool-reliability-guard';

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
    // Phase 1/3/7: edit stagnation
    editStagnationDetected: boolean;
    editStagnationType: 'READ_EDIT_LOOP' | 'REPEATED_EDIT_FAIL' | null;
    editStagnationFailures: number;
    platformShellRisks: number;
    pythonPatchValidationRisks: number;
    idleTurnDetected: boolean;
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
    editStagnationDetected: false,
    editStagnationType: null,
    editStagnationFailures: 0,
    platformShellRisks: 0,
    pythonPatchValidationRisks: 0,
    idleTurnDetected: false,
  };

  // Pre-calculate tool verification results once (limited to last 50 turns).
  const toolResults = verifyAllToolResults(messages);

  // 0. Phase 1/3/7 — Edit stagnation detection (highest priority among tool checks).
  // Detects Read→Edit fail→Read→Edit fail loops and repeated consecutive edit failures.
  // Fires BEFORE the generic loop detector so the model gets targeted edit guidance first.
  const stagnationResult = detectEditStagnation(messages);
  if (stagnationResult.detected && stagnationResult.diagnostics) {
    diagnostics.editStagnationDetected = true;
    diagnostics.editStagnationType = stagnationResult.stagnationType;
    diagnostics.editStagnationFailures = stagnationResult.diagnostics.failureCount;
    guidanceParts.push(stagnationResult.guidance);

    // Phase 7 — Loop breaker: if failures >= 3, inject mandatory strategy change
    if (stagnationResult.diagnostics.failureCount >= 3) {
      guidanceParts.push(
        '---\n' +
        '[LOOP_BREAKER] MANDATORY: Change strategy now. DO NOT make another identical edit attempt.\n' +
        '• Write the full file content, or use an insert-based approach.\n' +
        '• If still blocked, stop and report to the user.\n' +
        '---'
      );
    }

    console.warn(
      `[behavior-auditor] edit stagnation: type=${stagnationResult.stagnationType}` +
      ` tool=${stagnationResult.diagnostics.toolName}` +
      ` file=${stagnationResult.diagnostics.filePath}` +
      ` failures=${stagnationResult.diagnostics.failureCount}` +
      ` failureType=${stagnationResult.diagnostics.lastFailureType}`,
    );
  }

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
  const completionResult = detectPrematureCompletion(messages, toolResults);
  if (completionResult.prematureCompletion) {
    diagnostics.prematureCompletion = true;
    guidanceParts.push(completionResult.guidance);
    console.warn(
      `[behavior-auditor] premature completion: failed=${completionResult.failedToolCount}` +
      ` uncertain=${completionResult.uncertainToolCount}`,
    );
  }

  // 3. Path guard — scan ONLY the most recent assistant turn (per-request scope).
  //    Scanning the full history causes path issues to accumulate across requests.
  //    We only care about paths from tool calls in the latest assistant message.
  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
  const pathScopeMessages = lastAssistantMsg ? [lastAssistantMsg] : [];
  const pathIssues = inspectHistoryPaths(pathScopeMessages);
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
    const specResult = validateSpec(systemText, messages, toolResults);
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

  // 8b. Platform-aware shell patching guard.
  const shellRiskResult = detectPlatformShellPatchRisks(messages);
  if (shellRiskResult.risks.length > 0) {
    diagnostics.platformShellRisks = shellRiskResult.risks.length;
    const shellGuidance = buildPlatformShellGuidance(shellRiskResult.platform, shellRiskResult.risks);
    if (shellGuidance) guidanceParts.push(shellGuidance);
    console.warn(
      `[behavior-auditor] platform shell patch risks: ${shellRiskResult.risks.length} (${shellRiskResult.platform})`,
    );
  }

  // 8c. Generated Python patch script validation guard.
  const pyPatchRisks = detectPythonPatchValidationRisks(messages);
  if (pyPatchRisks.length > 0) {
    diagnostics.pythonPatchValidationRisks = pyPatchRisks.length;
    const pyGuidance = buildPythonPatchValidationGuidance(pyPatchRisks);
    if (pyGuidance) guidanceParts.push(pyGuidance);
    console.warn(`[behavior-auditor] python patch validation risks: ${pyPatchRisks.length}`);
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

  // 10. Autonomous Enforcement — check for "instructional idling".
  // If the last assistant message contains text instructions but NO tool calls,
  // and the user hasn't explicitly asked for an explanation, nudge the model to act.
  if (lastAssistantMsg && Array.isArray(lastAssistantMsg.content)) {
    const hasToolCalls = lastAssistantMsg.content.some((b: any) => b.type === 'tool_use');
    const hasThinking = lastAssistantMsg.content.some((b: any) => b.type === 'thinking');
    const textBlocks = lastAssistantMsg.content.filter((b: any) => b.type === 'text' && b.text?.length > 20);
    
    const isPurelyInstructional = !hasToolCalls && textBlocks.length > 0;
    const containsTaskDelegation = textBlocks.some((b: any) => 
      /\b(?:you (?:should|could|can)|please (?:add|modify|run|include)|manually)\b/i.test(b.text)
    );

    if (isPurelyInstructional && containsTaskDelegation) {
      diagnostics.idleTurnDetected = true;
      guidanceParts.push(
        '---\n' +
        '[AUTONOMOUS_ENFORCEMENT] CRITICAL: You provided instructions to the user but took NO action.\n' +
        '• DO NOT ask the user to perform implementation steps. You have tools (write_to_file, run_command, etc.).\n' +
        '• If a dependency or CDN is needed, add it to the file yourself.\n' +
        '• Perform the requested task using tool calls NOW.\n' +
        '---'
      );
      console.warn('[behavior-auditor] idle turn detected: model delegated task to user');
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
  // Optimization: Scan only recent history (last 30 messages)
  const scanLimit = 30;
  const messagesToScan = messages.slice(-scanLimit);
  
  for (const msg of messagesToScan) {
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
  // Optimization: Already scoped to last 15 in call site, but we ensure it here.
  const scanLimit = 15;
  const messagesToScan = messages.slice(-scanLimit);

  for (const msg of messagesToScan) {
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
