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

const MIN_REPEATS = 2; // 2nd identical failure → already a problem
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
  if (typeof content === 'string') return { text: content, isError: false };
  if (!Array.isArray(content)) return { text: '', isError: false };
  const text = content
    .map((c: any) => {
      if (typeof c === 'string') return c;
      if (c?.type === 'text' && typeof c.text === 'string') return c.text;
      return '';
    })
    .join('\n');
  return { text, isError: false };
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
          byId.set(block.id, {
            id: block.id,
            name: String(block.name || 'unknown'),
            inputSig: `${block.name}|${inputStr}`,
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

export function detectFailureLoop(messages: any[]): LoopDetectionResult {
  if (!Array.isArray(messages) || messages.length < 2) {
    return { detected: false, guidance: '', diagnostics: null };
  }

  const pairs = buildPairs(messages);
  if (pairs.length < MIN_REPEATS) {
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

  if (runCount < MIN_REPEATS || !lastFailed) {
    return { detected: false, guidance: '', diagnostics: null };
  }

  const guidance = [
    '',
    '---',
    `[GATEWAY LOOP DETECTOR] The previous ${runCount} attempts to call tool \`${lastFailed.name}\` with the same arguments all failed with an error. DO NOT repeat the identical call.`,
    '',
    'Required next step:',
    '1. Read the error message carefully and identify the root cause.',
    '2. Verify your assumptions before retrying — e.g. if a path is missing, list the parent directory first; if a command was not found, check the working directory or use an alternative tool.',
    '3. Change at least one parameter, the tool itself, or the strategy. An identical retry will produce an identical failure.',
    '4. If the error indicates a missing prerequisite (directory, file, dependency), create or locate it first via a different tool call.',
    '5. If you cannot determine a corrective action, stop calling tools and report the blocker in plain text to the user.',
    '',
    `Last error observed: ${lastFailed.errorText.slice(0, 240) || '(empty)'}`,
    '---',
    '',
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
