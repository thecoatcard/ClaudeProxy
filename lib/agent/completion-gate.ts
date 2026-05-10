// CompletionGate — detect premature "task complete" claims in message history.
//
// The gateway sees the full message history before each request. If an
// assistant turn contains a completion signal ("Done", "All tasks complete",
// "I've finished", etc.) but the tool call record shows unverified or failed
// operations, the model may be declaring victory prematurely. We inject a
// warning into systemInstruction so the model does not do this again.
//
// Pure functions, no I/O, no Node APIs. Edge-runtime safe.

import { verifyAllToolResults } from './verification-engine';

export interface CompletionGateResult {
  prematureCompletion: boolean;
  guidance: string;
  unverifiedClaims: string[];    // text excerpts that look like completion signals
  failedToolCount: number;
  uncertainToolCount: number;
}

// Patterns in assistant text that signal the agent believes the task is done.
// We match near the end of a message to avoid false positives from e.g.
// "I will create a done.txt file" mid-turn.
const COMPLETION_SIGNAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\ball (tasks?|steps?|items?|requirements?)\s+(are\s+)?(complete|done|finished|accomplished)/i, label: 'all tasks complete' },
  { pattern: /\btask(s)?\s+(is|are|have been)\s+(complete|done|finished)/i, label: 'task done' },
  { pattern: /\b(everything\s+is\s+|all\s+is\s+)(done|complete|finished|in\s+order)/i, label: 'everything done' },
  { pattern: /\b(the\s+)?implementation\s+is\s+(complete|done|finished)/i, label: 'implementation complete' },
  { pattern: /\bi(\'ve|\s+have)\s+(completed?|finished?|done)\s+(all|the|every)/i, label: 'i have completed all' },
  { pattern: /\byou\s+(should\s+now\s+)?(have|see|find)\s+(a\s+working|the\s+complete|all\s+the\s+required)/i, label: 'you should now have' },
  { pattern: /\bsetup\s+is\s+(complete|done|ready)/i, label: 'setup complete' },
  { pattern: /^(done|complete|finished)[.!]?\s*$/im, label: '"done" standalone' },
];

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join(' ');
}

function findCompletionSignals(text: string): string[] {
  const signals: string[] = [];
  for (const { pattern, label } of COMPLETION_SIGNAL_PATTERNS) {
    if (pattern.test(text)) signals.push(label);
  }
  return signals;
}

export function detectPrematureCompletion(messages: any[]): CompletionGateResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { prematureCompletion: false, guidance: '', unverifiedClaims: [], failedToolCount: 0, uncertainToolCount: 0 };
  }

  // Scan the LAST assistant message that contains actual TEXT for completion signals.
  // BUG-007 FIX: A turn with only tool_use blocks (no text) used to cause the gate to
  // skip the claim in the preceding text-bearing turn. We now scan back up to 5
  // assistant messages until we find one with non-empty text content.
  let lastAssistantText = '';
  let scanned = 0;
  for (let i = messages.length - 1; i >= 0 && scanned < 5; i--) {
    if (messages[i].role === 'assistant') {
      scanned++;
      const candidate = extractText(messages[i].content);
      if (candidate.trim()) {
        lastAssistantText = candidate;
        break;
      }
    }
  }

  const signals = findCompletionSignals(lastAssistantText);
  if (signals.length === 0) {
    return { prematureCompletion: false, guidance: '', unverifiedClaims: [], failedToolCount: 0, uncertainToolCount: 0 };
  }

  // There is a completion signal. Now check if the tool record supports it.
  const allResults = verifyAllToolResults(messages);
  const failedCount = allResults.filter(r => r.verdict === 'failure').length;
  const uncertainCount = allResults.filter(r => r.verdict === 'uncertain').length;

  // If there are NO tool calls at all with a success verdict, the claim is very suspicious.
  // If there are FAILED tools at the time of claiming done, block.
  if (failedCount === 0 && allResults.filter(r => r.verdict === 'success').length > 0) {
    // All observed tools succeeded — claim looks legitimate.
    return { prematureCompletion: false, guidance: '', unverifiedClaims: signals, failedToolCount: 0, uncertainToolCount: uncertainCount };
  }

  if (failedCount === 0 && allResults.length === 0) {
    // Claimed done without any tool calls — might be a text-only task, don't block.
    return { prematureCompletion: false, guidance: '', unverifiedClaims: signals, failedToolCount: 0, uncertainToolCount: 0 };
  }

  // There are either failures or all results are uncertain — the claim is premature.
  const guidance = [
    '---',
    `[COMPLETION GATE] Completion claimed but ${failedCount > 0 ? `${failedCount} tool(s) failed` : ''}${uncertainCount > 0 ? ` ${uncertainCount} uncertain` : ''}. Do NOT claim done until all required tools succeeded with evidence.`,
    failedCount > 0 ? `• ${failedCount} tool call(s) failed.` : '',
    uncertainCount > 0 ? `• ${uncertainCount} result(s) ambiguous.` : '',
    'Cite specific tool results as evidence before claiming completion.',
    '---',
  ].filter(line => line !== '').join('\n');

  return {
    prematureCompletion: true,
    guidance,
    unverifiedClaims: signals,
    failedToolCount: failedCount,
    uncertainToolCount: uncertainCount,
  };
}
