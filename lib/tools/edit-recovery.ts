// Edit recovery strategy guidance — Claude Code-like edit recovery protocol.
// Pure function — no I/O, edge-runtime safe.
//
// Claude Code edit recovery protocol:
//   Attempt 1 (first failure):  Re-read → re-extract exact text → retry smaller patch
//   Attempt 2 (second failure): Pivot strategy → Write full file OR Insert-based patch
//   Attempt 3+:                 Mandatory strategy change; stop edit retries
//
// Phase 4 — Write fallback: recommend Write when structural change is safer
// Phase 5 — Patch granularity: flag large old_string blocks and suggest splitting

import type { EditFailureType } from './edit-failure-classifier';

/** Characters in old_string above which a patch is considered "large". */
export const LARGE_PATCH_THRESHOLD = 400;

export type RecoveryStep =
  | 'REREAD_AND_RETRY'   // Re-read file, extract exact text, retry smaller patch
  | 'WRITE_FALLBACK'     // Write full file instead of patching
  | 'INSERT_FALLBACK'    // Use insert-line approach
  | 'ESCALATE';          // Mandatory strategy change; stop edit retries

export interface EditRecoveryGuidance {
  step: RecoveryStep;
  guidance: string;
}

/**
 * Returns recovery guidance based on attempt count and failure type.
 *
 * @param attemptCount     How many times this edit has failed (1 = first failure)
 * @param failureType      Classified failure type from edit-failure-classifier
 * @param filePath         The file being edited (for display)
 * @param oldStringLength  Length of old_string (for patch granularity check)
 */
export function buildEditRecoveryGuidance(
  attemptCount: number,
  failureType: EditFailureType,
  filePath: string | null,
  oldStringLength = 0,
): EditRecoveryGuidance {
  const fileRef = filePath ? `\`${filePath}\`` : 'the file';
  const isLargePatch = oldStringLength > LARGE_PATCH_THRESHOLD;

  // Phase 7 (ESCALATE) — 3+ failures
  if (attemptCount >= 3) {
    return {
      step: 'ESCALATE',
      guidance: [
        '---',
        `[EDIT_RECOVERY] Edit of ${fileRef} failed ${attemptCount} times. MANDATORY strategy change required.`,
        '• DO NOT retry the same edit operation again.',
        '• Switch strategy: use Write to replace the entire file content, or restructure the approach.',
        '• If the task is blocked, report to the user — do not enter an infinite loop.',
        '---',
      ].join('\n'),
    };
  }

  // Phase 4 (WRITE_FALLBACK) — second failure → pivot to Write
  if (attemptCount === 2) {
    return {
      step: 'WRITE_FALLBACK',
      guidance: buildWriteFallbackHint(fileRef, failureType),
    };
  }

  // Phase 3 + Phase 5 — first failure
  // If patch block is large, flag granularity first
  if (isLargePatch) {
    return {
      step: 'REREAD_AND_RETRY',
      guidance: [
        '---',
        `[EDIT_RECOVERY] Edit of ${fileRef} failed (${failureType}). Patch block too large.`,
        checkPatchGranularity(oldStringLength),
        '• Re-read the file first to get fresh content.',
        '• Retry with a smaller, more targeted old_string (< 400 chars).',
        '• If the second edit also fails, switch to Write strategy.',
        '---',
      ].join('\n'),
    };
  }

  // Standard first-failure recovery
  const specificHint = getFailureSpecificHint(failureType);
  return {
    step: 'REREAD_AND_RETRY',
    guidance: [
      '---',
      `[EDIT_RECOVERY] Edit of ${fileRef} failed (${failureType}).`,
      specificHint,
      '• Step 1: Re-read the file to get the current exact content.',
      '• Step 2: Extract the exact text to replace (copy verbatim, including all whitespace).',
      '• Step 3: Retry with a smaller, more targeted old_string if possible.',
      '• Max 2 edit retries before switching to Write strategy.',
      '---',
    ].join('\n'),
  };
}

/**
 * Phase 4 — Write fallback hint.
 * Used when a second edit attempt also fails.
 */
export function buildWriteFallbackHint(fileRef: string, failureType: EditFailureType): string {
  return [
    '---',
    `[EDIT_RECOVERY] Edit of ${fileRef} failed twice (${failureType}). Pivot to Write strategy.`,
    '• Write the complete updated file content using a write/create tool.',
    '• For large files: split into multiple smaller targeted str_replace hunks.',
    '• Do NOT make a third str_replace attempt for the same file.',
    '---',
  ].join('\n');
}

/**
 * Phase 5 — Patch granularity check.
 * Returns a hint string if old_string exceeds the threshold; empty string otherwise.
 */
export function checkPatchGranularity(oldStringLength: number): string {
  if (oldStringLength <= LARGE_PATCH_THRESHOLD) return '';
  return (
    `• Large patch detected (${oldStringLength} chars). Split into smaller hunks: ` +
    `prefer old_string < ${LARGE_PATCH_THRESHOLD} chars, targeting one logical change at a time.`
  );
}

function getFailureSpecificHint(type: EditFailureType): string {
  switch (type) {
    case 'EXACT_MATCH_FAILURE':
      return '• The old_string was not found verbatim — file may have changed. Re-read first.';
    case 'FILE_CHANGED':
      return '• File was modified after last read. Must re-read before editing.';
    case 'WHITESPACE_MISMATCH':
      return '• Whitespace/indentation mismatch. Copy exact indentation from the re-read content.';
    case 'MULTIPLE_MATCHES':
      return '• Multiple matches found. Add more surrounding context lines to make old_string unique.';
    case 'NO_MATCH_FOUND':
      return '• No match found. Re-read to verify the text still exists as expected.';
    default:
      return '• Re-read the file to understand the current state before retrying.';
  }
}
