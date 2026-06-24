// Edit failure classifier — pure classification of edit tool failures from
// tool_result content. Supports Claude Code's str_replace_based_edit_tool
// and common variants.
//
// No I/O, no side effects, edge-runtime safe.

export type EditFailureType =
  | 'EXACT_MATCH_FAILURE'   // oldString not found verbatim
  | 'FILE_CHANGED'          // file was modified between read and edit
  | 'WHITESPACE_MISMATCH'   // indentation / whitespace differs
  | 'MULTIPLE_MATCHES'      // oldString matches more than one location
  | 'NO_MATCH_FOUND'        // no occurrence located
  | 'UNKNOWN';              // unrecognized error pattern

export interface EditFailureClassification {
  type: EditFailureType;
  confidence: 'high' | 'medium' | 'low';
  rawError: string;
  recoveryHint: string;
}

// ── Tool name registries ─────────────────────────────────────────────────────

/** Tool names treated as "edit" operations. */
export const EDIT_TOOL_NAMES = new Set([
  'str_replace_based_edit_tool',
  'str_replace_editor',
  'edit_file',
  'replace_in_file',
  'multi_replace_string_in_file',
  'replace_string_in_file',
  'write_file',
  'create_file',
  'patch',
]);

/** Tool names treated as "read" / view operations. */
export const READ_TOOL_NAMES = new Set([
  'read_file',
  'view_file',
  'view',
  'cat',
  'head',
  'tail',
  'get_file',
  'open_file',
]);

export function isEditTool(toolName: string): boolean {
  return EDIT_TOOL_NAMES.has(toolName.toLowerCase());
}

export function isReadTool(toolName: string): boolean {
  return READ_TOOL_NAMES.has(toolName.toLowerCase());
}

/** Extract the file path from various tool input schemas. */
export function extractFilePath(toolInput: Record<string, any> | null | undefined): string | null {
  if (!toolInput) return null;
  return (
    toolInput.path ??
    toolInput.file_path ??
    toolInput.filename ??
    toolInput.filePath ??
    toolInput.file ??
    null
  );
}

/** Normalize path for comparison: backslash → slash, lowercase, trim trailing slash. */
export function normalizePath(p: string | null | undefined): string | null {
  if (!p) return null;
  return p
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
    .trim();
}

/** Normalize line endings for comparison: CRLF / CR → LF. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ── Classification rules (ordered by specificity) ────────────────────────────

const CLASSIFICATION_RULES: Array<{
  patterns: RegExp[];
  type: EditFailureType;
  confidence: 'high' | 'medium' | 'low';
  recoveryHint: string;
}> = [
  {
    patterns: [
      /multiple matches found/i,
      /ambiguous.*old_str/i,
      /found \d+ matches/i,
      /matches more than one/i,
      /more than one occurrence/i,
    ],
    type: 'MULTIPLE_MATCHES',
    confidence: 'high',
    recoveryHint:
      'Add more surrounding context lines to old_string to make the match unique.',
  },
  {
    patterns: [
      /whitespace mismatch/i,
      /leading whitespace/i,
      /indentation.*differ/i,
      /trailing whitespace/i,
      /tabs? vs\.? spaces/i,
      /mixed indentation/i,
    ],
    type: 'WHITESPACE_MISMATCH',
    confidence: 'high',
    recoveryHint:
      'Re-read the file and copy the exact indentation/whitespace from the current content.',
  },
  {
    patterns: [
      /old_?string not found/i,
      /no match found for.*old_str/i,
      /string not found in file/i,
      /exact match not found/i,
      /could not find.*old_?string/i,
      /old_?str.*not found/i,
      /did not find.*str/i,
      /failed to find.*old_?str/i,
    ],
    type: 'EXACT_MATCH_FAILURE',
    confidence: 'high',
    recoveryHint:
      'Re-read the file to get the current exact content before retrying the edit.',
  },
  {
    patterns: [
      /file.*modified.*since/i,
      /content.*changed.*since/i,
      /stale.*content/i,
      /file.*has changed/i,
      /content.*out of date/i,
    ],
    type: 'FILE_CHANGED',
    confidence: 'high',
    recoveryHint:
      'Re-read the file — it was modified between the read and edit. Use fresh content.',
  },
  {
    patterns: [
      /no such file/i,
      /file not found/i,
      /does not exist/i,
      /enoent/i,
    ],
    type: 'FILE_CHANGED',
    confidence: 'medium',
    recoveryHint:
      'Verify the file path is correct and the file was created by a preceding step.',
  },
  {
    patterns: [
      /no.*match/i,
      /not found/i,
      /could not locate/i,
      /unable to find/i,
      /cannot find/i,
    ],
    type: 'NO_MATCH_FOUND',
    confidence: 'medium',
    recoveryHint:
      'Re-read the file and verify the text to replace still exists in its expected form.',
  },
];

/**
 * Classify an edit failure from the raw tool_result content string.
 * Returns UNKNOWN when no known pattern matches.
 */
export function classifyEditFailure(toolResultContent: string): EditFailureClassification {
  const normalized = normalizeLineEndings(toolResultContent || '');

  for (const rule of CLASSIFICATION_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalized)) {
        return {
          type: rule.type,
          confidence: rule.confidence,
          rawError: toolResultContent.slice(0, 400),
          recoveryHint: rule.recoveryHint,
        };
      }
    }
  }

  return {
    type: 'UNKNOWN',
    confidence: 'low',
    rawError: toolResultContent.slice(0, 400),
    recoveryHint:
      'Re-read the file and verify the edit parameters before retrying.',
  };
}
