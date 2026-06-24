// VerificationEngine — content-based tool-result analysis.
//
// The gateway cannot call fs.existsSync() or spawn processes — it runs on
// Edge runtime. This module infers tool-call success/failure from the *text*
// of tool_result content blocks. That is the only evidence available to a
// translation proxy. No I/O, no Node APIs. Edge-runtime safe.
//
// Verdicts:
//   success   — result text indicates the operation completed as intended.
//   failure   — result text contains an explicit error signal.
//   uncertain — no clear signal either way (e.g. empty result, ambiguous output).

export type VerificationVerdict = 'success' | 'failure' | 'uncertain';

export interface VerificationResult {
  toolName: string;
  verdict: VerificationVerdict;
  evidence: string;
}

// Patterns that reliably indicate failure regardless of tool.
const FAILURE_PATTERNS: RegExp[] = [
  /\bno such file or directory\b/i,
  /\benoent\b/i,
  /\bpermission denied\b/i,
  /\baccess denied\b/i,
  /\bcommand not found\b/i,
  /\bnot recognized as (an )?internal or external command\b/i,
  /\bsyntaxerror\b/i,
  /\btraceback \(most recent call last\)\b/i,
  /^\s*error:/im,
  /\bfailed to (read|write|open|execute|connect)\b/i,
  /\bcannot (find|access|read|write|open)\b/i,
  /\btool execution failed\b/i,
  /\bexited with (code|status) [1-9]/i,
  /\bkilled\b.*signal/i,
];

// Patterns that indicate success for specific tool families.
const WRITE_SUCCESS_PATTERNS: RegExp[] = [
  /\bfile (created|written|saved|updated)\b/i,
  /\bsuccess(fully)? (written|created|saved)\b/i,
  /\bnew file\b/i,
  /^\s*ok\s*$/im,
];

const READ_SUCCESS_PATTERNS: RegExp[] = [
  /\S/, // Any non-whitespace content — the file was readable and returned data.
];

const BASH_SUCCESS_PATTERNS: RegExp[] = [
  // For bash, absence of error is the main signal. We check for explicit success indicators.
  /\b(done|complete|finished|ok|success)\b/i,
];

const DELETE_SUCCESS_PATTERNS: RegExp[] = [
  /\b(deleted|removed|unlinked)\b/i,
  /^\s*ok\s*$/im,
];

const MOVE_SUCCESS_PATTERNS: RegExp[] = [
  /\b(moved|renamed|relocated)\b/i,
  /^\s*ok\s*$/im,
];

const SEARCH_SUCCESS_PATTERNS: RegExp[] = [
  /\S/, // Any result at all is success for a search.
];

/** Normalize tool name to a tool family. */
function normalizeTool(toolName: string): string {
  const t = toolName.toLowerCase().replace(/[^a-z_]/g, '_');
  if (/write|str_replace|edit|create_file|apply_patch/.test(t)) return 'write';
  if (/read|cat|view|open/.test(t)) return 'read';
  if (/bash|shell|exec|run|terminal/.test(t)) return 'bash';
  if (/delete|remove|unlink|rm_/.test(t)) return 'delete';
  if (/move|rename|mv_/.test(t)) return 'move';
  if (/search|grep|glob|find|ripgrep/.test(t)) return 'search';
  if (/list|ls_|dir_/.test(t)) return 'list';
  return 'generic';
}

function isFailure(text: string): { failed: boolean; evidence: string } {
  for (const re of FAILURE_PATTERNS) {
    const m = text.match(re);
    if (m) return { failed: true, evidence: m[0] };
  }
  return { failed: false, evidence: '' };
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(re => re.test(text));
}

export function verifyToolResult(
  toolName: string,
  _input: any,
  resultText: string,
  isError: boolean,
): VerificationResult {
  const family = normalizeTool(toolName);
  const trimmed = resultText.trim();

  // Explicit error flag from the client always means failure.
  if (isError) {
    return {
      toolName,
      verdict: 'failure',
      evidence: `tool_result.is_error=true: ${trimmed.slice(0, 200)}`,
    };
  }

  // Check universal failure patterns first.
  const { failed, evidence } = isFailure(trimmed);
  if (failed) {
    return { toolName, verdict: 'failure', evidence: `Error pattern matched: "${evidence}"` };
  }

  // Empty result is uncertain (not necessarily bad — some tools return nothing on success).
  if (!trimmed) {
    return {
      toolName,
      verdict: 'uncertain',
      evidence: 'Tool returned empty result — cannot confirm success.',
    };
  }

  // Tool-family-specific success checks.
  switch (family) {
    case 'write':
      return matchesAny(trimmed, WRITE_SUCCESS_PATTERNS) || trimmed.length > 0
        ? { toolName, verdict: 'success', evidence: 'Write operation returned non-error content.' }
        : { toolName, verdict: 'uncertain', evidence: 'Write result ambiguous.' };

    case 'read':
      return matchesAny(trimmed, READ_SUCCESS_PATTERNS)
        ? { toolName, verdict: 'success', evidence: `Read returned ${trimmed.length} chars of content.` }
        : { toolName, verdict: 'uncertain', evidence: 'Read returned no content.' };

    case 'bash':
      // Bash success: no error patterns AND some output OR explicit success marker.
      return { toolName, verdict: 'success', evidence: 'Bash returned output with no error markers.' };

    case 'delete':
      return matchesAny(trimmed, DELETE_SUCCESS_PATTERNS)
        ? { toolName, verdict: 'success', evidence: 'Delete operation confirmed.' }
        : { toolName, verdict: 'uncertain', evidence: 'Delete result ambiguous — no explicit confirmation.' };

    case 'move':
      return matchesAny(trimmed, MOVE_SUCCESS_PATTERNS)
        ? { toolName, verdict: 'success', evidence: 'Move/rename confirmed.' }
        : { toolName, verdict: 'uncertain', evidence: 'Move result ambiguous.' };

    case 'search':
    case 'list':
      return matchesAny(trimmed, SEARCH_SUCCESS_PATTERNS)
        ? { toolName, verdict: 'success', evidence: 'Search/list returned results.' }
        : { toolName, verdict: 'uncertain', evidence: 'Search returned no results.' };

    default:
      return {
        toolName,
        verdict: 'uncertain',
        evidence: 'Unknown tool family — cannot infer success from content.',
      };
  }
}

/** Batch-verify all tool pairs in a message history. */
export function verifyAllToolResults(messages: any[]): VerificationResult[] {
  const results: VerificationResult[] = [];

  // Optimization: Scan only the last 50 messages. Tool verification is
  // usually most relevant for the most recent actions.
  const scanLimit = 50;
  const messagesToScan = (messages || []).slice(-scanLimit);

  // Build id → tool_use map from assistant messages.
  const toolUseByID = new Map<string, { name: string; input: any }>();
  for (const msg of messagesToScan) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          toolUseByID.set(block.id, { name: block.name, input: block.input });
        }
      }
    }
  }

  // Walk tool_result blocks in user messages.
  for (const msg of messagesToScan) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_result') continue;
      const toolUse = toolUseByID.get(block.tool_use_id);
      if (!toolUse) continue;

      // Extract text from content (string or array of text blocks).
      let text = '';
      if (typeof block.content === 'string') {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        text = block.content
          .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
          .join('\n');
      }

      results.push(verifyToolResult(toolUse.name, toolUse.input, text, block.is_error === true));
    }
  }

  return results;
}
