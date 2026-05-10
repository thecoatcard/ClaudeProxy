// Detect repeated identical failed tool invocations in the Anthropic message
// history and produce a corrective system-prompt fragment that nudges the
// model out of the loop. Pure function — no I/O, edge-runtime safe.
//
// We look ONLY at the message history the client sent us. The gateway does
// not execute tools; the client (e.g. Claude Code) does. By the time the
// client comes back to us with the next turn, any failed tool_result is
// already present in `messages` as a `user` message containing one or more
// `tool_result` blocks with `is_error: true` OR error-shaped text content.
//
// Heuristic:
//   1. Walk `messages` in order, building (assistant tool_use → user tool_result)
//      pairs keyed by tool_use.id.
//   2. Compute a stable signature per pair: `${name}|${stableStringify(input)}`.
//   3. A pair is "failed" if its tool_result has is_error=true, OR its content
//      (string or text blocks) matches a known error pattern.
//   4. Group consecutive failed pairs by signature. If any group has count
//      >= MIN_REPEATS, we emit a corrective fragment.
//
// The corrective fragment is appended to systemInstruction (NOT to user
// turns, so the model treats it as authoritative guidance, not a new task).

import { getAdaptiveLoopPolicy } from './adaptive-loop-policy';
import {
  isEditTool,
  isReadTool,
  extractFilePath,
  normalizePath,
  normalizeLineEndings,
  classifyEditFailure,
} from '../tools/edit-failure-classifier';
import { buildEditRecoveryGuidance, checkPatchGranularity, LARGE_PATCH_THRESHOLD } from '../tools/edit-recovery';
import {
  buildFreshSnapshotGuidance,
  buildStructureAwarePatchGuidance,
  hashFileSnapshot,
} from '../tools/structure-aware-patch';

const ERROR_TEXT_PATTERNS = [
  /no such file or directory/i,
  /enoent/i,
  /permission denied/i,
  /command not found/i,
  /not recognized as (an )?internal or external command/i,
  /\binvalid (input|argument|parameter)/i,
  /\bfailed to (read|write|open|execute)\b/i,
  /\bcannot (find|access|read|write)\b/i,
  /^error:/im,
  /tool execution failed/i,
];

export interface LoopDetectionResult {
  detected: boolean;
  /** When detected, this is appended to systemInstruction. Empty string otherwise. */
  guidance: string;
  /** Diagnostic detail — useful for logs. */
  diagnostics: {
    toolName: string;
    repeats: number;
    inputPreview: string;
    errorPreview: string;
  } | null;
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function extractToolResultText(content: any): { text: string; isError: boolean } {
  // tool_result blocks may have content as string OR array of text/image parts.
  // is_error is set on the tool_result block itself, surfaced by the caller.
  if (typeof content === 'string') return { text: normalizeLineEndings(content), isError: false };
  if (!Array.isArray(content)) return { text: '', isError: false };
  const text = content
    .map((c: any) => {
      if (typeof c === 'string') return c;
      if (c?.type === 'text' && typeof c.text === 'string') return c.text;
      return '';
    })
    .join('\n');
  return { text: normalizeLineEndings(text), isError: false };
}

function looksLikeError(text: string): boolean {
  if (!text) return false;
  return ERROR_TEXT_PATTERNS.some(re => re.test(text));
}

interface ToolPair {
  id: string;
  name: string;
  inputSig: string;
  inputPreview: string;
  errorText: string;
  failed: boolean;
}

function buildPairs(messages: any[]): ToolPair[] {
  // Map tool_use.id → partial pair. Filled when its tool_result is encountered.
  const byId = new Map<string, ToolPair>();
  const order: string[] = [];

  for (const msg of messages || []) {
    if (!Array.isArray(msg.content)) continue;
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          const inputStr = stableStringify(block.input ?? {});
          // Phase 8: normalize paths in tool input for cross-platform comparison
          const normalizedInputStr = inputStr.replace(/\\\\/g, '/').replace(/\r\n/g, '\n');
          byId.set(block.id, {
            id: block.id,
            name: String(block.name || 'unknown'),
            inputSig: `${block.name}|${normalizedInputStr}`,
            inputPreview: inputStr.length > 200 ? inputStr.slice(0, 200) + '…' : inputStr,
            errorText: '',
            failed: false,
          });
          order.push(block.id);
        }
      }
    } else if (msg.role === 'user') {
      for (const block of msg.content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const pair = byId.get(block.tool_use_id);
          if (!pair) continue;
          const { text } = extractToolResultText(block.content);
          const isErr = block.is_error === true || looksLikeError(text);
          pair.errorText = text.slice(0, 400);
          pair.failed = isErr;
        }
      }
    }
  }

  return order.map(id => byId.get(id)!).filter(Boolean);
}

export function detectFailureLoop(messages: any[], internalModel?: string): LoopDetectionResult {
  const policy = getAdaptiveLoopPolicy(internalModel);
  if (!Array.isArray(messages) || messages.length < 2) {
    return { detected: false, guidance: '', diagnostics: null };
  }

  const pairs = buildPairs(messages);
  if (pairs.length < policy.minRepeats) {
    return { detected: false, guidance: '', diagnostics: null };
  }

  // Walk from the END backwards: only consecutive failures with same signature
  // touching the latest turn matter. Old resolved errors should not trigger.
  let runSig: string | null = null;
  let runCount = 0;
  let lastFailed: ToolPair | null = null;

  for (let i = pairs.length - 1; i >= 0; i--) {
    const p = pairs[i];
    if (!p.failed) break;
    if (runSig === null) {
      runSig = p.inputSig;
      runCount = 1;
      lastFailed = p;
    } else if (p.inputSig === runSig) {
      runCount++;
    } else {
      break;
    }
  }

  if (runCount < policy.minRepeats || !lastFailed) {
    // BUG-011 FIX: Check for alternating failure patterns: A→B→A→B where A and B
    // are different failed tool signatures. If any signature appears >= minRepeats
    // times in the tail of failed pairs, it qualifies as a loop.
    const failedPairs = pairs.filter(p => p.failed);
    if (failedPairs.length >= policy.minRepeats * 2) {
      const sigCounts = new Map<string, { pair: ToolPair; count: number }>();
      for (const p of failedPairs) {
        const entry = sigCounts.get(p.inputSig);
        if (entry) {
          entry.count++;
        } else {
          sigCounts.set(p.inputSig, { pair: p, count: 1 });
        }
      }
      for (const [, entry] of sigCounts) {
        if (entry.count >= policy.minRepeats) {
          const alt = entry.pair;
          const guidance = [
            '---',
            `[LOOP] \`${alt.name}\` failed ${entry.count}× (non-consecutive). DO NOT retry the same call.`,
            '• Try a fundamentally different approach. Break the root blocker first.',
            '• If blocked: stop calling tools and report to the user.',
            `Error: ${alt.errorText.slice(0, 160) || '(empty)'}`,
            policy.extraGuidance,
            '---',
          ].join('\n');

          return {
            detected: true,
            guidance,
            diagnostics: {
              toolName: alt.name,
              repeats: entry.count,
              inputPreview: alt.inputPreview,
              errorPreview: alt.errorText.slice(0, 240),
            },
          };
        }
      }
    }
    return { detected: false, guidance: '', diagnostics: null };
  }

  const guidance = [
    '---',
    `[LOOP] \`${lastFailed.name}\` failed ${runCount}× with the same args. DO NOT repeat the identical call.`,
    '• Identify the root cause. Change the tool, args, or strategy.',
    '• If a prerequisite is missing, create/locate it via a different tool first.',
    '• If blocked: stop and report to the user.',
    `Error: ${lastFailed.errorText.slice(0, 160) || '(empty)'}`,
    policy.extraGuidance,
    '---',
  ].join('\n');

  return {
    detected: true,
    guidance,
    diagnostics: {
      toolName: lastFailed.name,
      repeats: runCount,
      inputPreview: lastFailed.inputPreview,
      errorPreview: lastFailed.errorText.slice(0, 240),
    },
  };
}

// ── Phase 1: Read→Edit stagnation detector ────────────────────────────────────
// Detects the pattern: Read file X → Edit file X (fail) → Read file X → Edit file X (fail)
// Classifies as TOOL_LOOP_STAGNATION and generates Claude Code-like recovery guidance.

export interface EditStagnationResult {
  detected: boolean;
  stagnationType: 'READ_EDIT_LOOP' | 'REPEATED_EDIT_FAIL' | null;
  guidance: string;
  diagnostics: {
    toolName: string;
    filePath: string | null;
    failureCount: number;
    lastFailureType: string;
    lastError: string;
  } | null;
}

/**
 * Detects Read→Edit fail→Read→Edit fail stagnation patterns.
 *
 * Two patterns are caught:
 *   1. READ_EDIT_LOOP: alternating Read/Edit pairs targeting the same file, where
 *      edits consistently fail.
 *   2. REPEATED_EDIT_FAIL: same edit tool + file fails 2+ consecutive times
 *      (without interleaved reads — pure edit hammering).
 */
export function detectEditStagnation(messages: any[]): EditStagnationResult {
  if (!Array.isArray(messages) || messages.length < 2) {
    return { detected: false, stagnationType: null, guidance: '', diagnostics: null };
  }

  // Build ordered tool calls with file path and failure info
  interface ToolCall {
    id: string;
    name: string;
    filePath: string | null;         // normalized
    rawFilePath: string | null;      // for display
    isEdit: boolean;
    isRead: boolean;
    failed: boolean;
    errorText: string;
    inputOldStringLength: number;    // for patch granularity check
    failureType: string;
  }

  const byId = new Map<string, ToolCall>();
  const order: string[] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;

    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const name = String(block.name || '');
        const rawFp = extractFilePath(block.input ?? {});
        const oldStr = block.input?.old_string ?? block.input?.old_str ?? '';
        byId.set(block.id, {
          id: block.id,
          name,
          filePath: normalizePath(rawFp),
          rawFilePath: rawFp,
          isEdit: isEditTool(name),
          isRead: isReadTool(name),
          failed: false,
          errorText: '',
          inputOldStringLength: typeof oldStr === 'string' ? oldStr.length : 0,
          failureType: 'UNKNOWN',
        });
        order.push(block.id);
      }
    } else if (msg.role === 'user') {
      for (const block of msg.content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        const { text } = extractToolResultText(block.content);
        call.failed = block.is_error === true || looksLikeError(text);
        call.errorText = text.slice(0, 400);
        if (call.failed) {
          call.failureType = classifyEditFailure(text).type;
        }
      }
    }
  }

  const calls = order.map(id => byId.get(id)!).filter(Boolean);
  if (calls.length < 2) {
    return { detected: false, stagnationType: null, guidance: '', diagnostics: null };
  }

  // ── Pattern 1: READ_EDIT_LOOP ─────────────────────────────────────────────
  // Look from the end: count (read, edit_fail) pairs for the same file.
  // We require at least 2 failed edit calls after at least 1 read for the same file.
  const fileEditFailCounts = new Map<string, { call: ToolCall; count: number }>();
  let readSeenForFile = new Set<string>();

  for (const call of calls) {
    if (call.isRead && call.filePath) {
      readSeenForFile.add(call.filePath);
    }
    if (call.isEdit && call.failed && call.filePath) {
      if (readSeenForFile.has(call.filePath)) {
        const entry = fileEditFailCounts.get(call.filePath);
        if (entry) {
          entry.count++;
        } else {
          fileEditFailCounts.set(call.filePath, { call, count: 1 });
        }
      }
    }
  }

  // Find worst offender (most failures)
  let worstFile: string | null = null;
  let worstEntry: { call: ToolCall; count: number } | null = null;
  for (const [fp, entry] of fileEditFailCounts) {
    if (!worstEntry || entry.count > worstEntry.count) {
      worstFile = fp;
      worstEntry = entry;
    }
  }

  if (worstEntry && worstEntry.count >= 2) {
    const { call, count } = worstEntry;
    const classification = classifyEditFailure(call.errorText);
    const recovery = buildEditRecoveryGuidance(
      count,
      classification.type,
      call.rawFilePath,
      call.inputOldStringLength,
    );
    const granularityHint = checkPatchGranularity(call.inputOldStringLength);
    const snapshotHash = call.errorText ? hashFileSnapshot(call.errorText) : null;

    const guidanceLines = [
      '---',
      `[TOOL_LOOP_STAGNATION] Read→Edit loop detected: \`${call.name}\` on \`${call.rawFilePath ?? 'unknown'}\` failed ${count}× after re-reads.`,
      `• Failure type: ${classification.type} — ${classification.recoveryHint}`,
      buildStructureAwarePatchGuidance(call.rawFilePath, classification.type),
      buildFreshSnapshotGuidance(call.rawFilePath, snapshotHash),
    ];
    if (granularityHint) guidanceLines.push(granularityHint);
    guidanceLines.push(recovery.guidance.replace(/^---\n/, '').replace(/\n---$/, ''));
    guidanceLines.push('---');

    return {
      detected: true,
      stagnationType: 'READ_EDIT_LOOP',
      guidance: guidanceLines.join('\n'),
      diagnostics: {
        toolName: call.name,
        filePath: call.rawFilePath,
        failureCount: count,
        lastFailureType: classification.type,
        lastError: call.errorText.slice(0, 240),
      },
    };
  }

  // ── Pattern 2: REPEATED_EDIT_FAIL ────────────────────────────────────────
  // Consecutive edit failures on the same file, even without re-reads.
  let runFile: string | null = null;
  let runTool: ToolCall | null = null;
  let runFailureType: string | null = null;
  let runCount = 0;

  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (!c.isEdit || !c.failed) break;
    if (runFile === null) {
      runFile = c.filePath;
      runTool = c;
      runFailureType = c.failureType;
      runCount = 1;
    } else if (
      c.filePath === runFile &&
      runTool &&
      c.name === runTool.name &&
      c.failureType === runFailureType
    ) {
      runCount++;
    } else {
      break;
    }
  }

  if (runCount >= 2 && runTool) {
    const classification = classifyEditFailure(runTool.errorText);
    const snapshotHash = runTool.errorText ? hashFileSnapshot(runTool.errorText) : null;
    const recovery = buildEditRecoveryGuidance(
      runCount,
      classification.type,
      runTool.rawFilePath,
      runTool.inputOldStringLength,
    );

    return {
      detected: true,
      stagnationType: 'REPEATED_EDIT_FAIL',
      guidance: [
        '---',
        `[TOOL_LOOP_STAGNATION] \`${runTool.name}\` failed ${runCount}× consecutively on \`${runTool.rawFilePath ?? 'unknown'}\`.`,
        `• Failure type: ${classification.type} — ${classification.recoveryHint}`,
        buildStructureAwarePatchGuidance(runTool.rawFilePath, classification.type),
        buildFreshSnapshotGuidance(runTool.rawFilePath, snapshotHash),
        recovery.guidance.replace(/^---\n/, '').replace(/\n---$/, ''),
        '---',
      ].join('\n'),
      diagnostics: {
        toolName: runTool.name,
        filePath: runTool.rawFilePath,
        failureCount: runCount,
        lastFailureType: classification.type,
        lastError: runTool.errorText.slice(0, 240),
      },
    };
  }

  return { detected: false, stagnationType: null, guidance: '', diagnostics: null };
}
