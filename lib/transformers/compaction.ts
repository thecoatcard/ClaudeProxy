/**
 * Message history compaction logic for the CoatCard AI Gateway.
 */
import {
  buildCompactedRangeId,
  buildStoredSummaryMessage,
  COMPACTED_MARKER_SENTINEL,
  generateChunkedSummary,
  saveCompactedSummary,
} from '../compactor/ai-compactor';

export interface CompactionOptions {
  maxMessages?: number;
  maxTokensApprox?: number;
  keepFirstN?: number;
  keepLastN?: number;
  rollingSummary?: string;
  summaryCharBudget?: number;
  failureAnchorDepth?: number;
  // If provided, used to call AI for semantic summarization
  apiKey?: string;
  model?: string;
  conversationId?: string;
  compactedRangeTtlSeconds?: number;
}

export interface CompactionResult {
  messages: any[];
  didCompact: boolean;
  originalMessageCount: number;
  compactedMessageCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  generatedSummary?: string;
}

const DEFAULT_OPTIONS: CompactionOptions = {
  maxMessages: 50,
  maxTokensApprox: 100000, 
  keepFirstN: 2,           
  keepLastN: 14,           
  summaryCharBudget: 3000,
  failureAnchorDepth: 3,
};

// Realistic token weights
const TOKEN_WEIGHTS = {
  CHAR: 0.25,
  IMAGE: 1000, // Gemini/Claude images are roughly 800-1600 tokens
  TOOL_CALL: 100,
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, maxChars: number): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function hasToolUse(message: any): boolean {
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((b: any) => b.type === 'tool_use');
}

function hasToolResult(message: any): boolean {
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((b: any) => b.type === 'tool_result');
}

function toolResultText(block: any): string {
  if (!block || block.type !== 'tool_result') return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((c: any) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  }
  return JSON.stringify(block.content || {});
}

function isToolFailureBlock(block: any): boolean {
  if (!block || block.type !== 'tool_result') return false;
  if (block.is_error === true) return true;
  const text = toolResultText(block).toLowerCase();
  if (!text) return false;
  return /(error|failed|enoent|no such file|permission denied|not found|invalid argument|exception|traceback|cannot)/i.test(text);
}

/**
 * Sentinel embedded in every summary message we generate.
 * Future compaction passes detect this to skip re-summarizing the same content.
 */
export const SUMMARY_SENTINEL = '<!-- compacted:v1 -->';

/**
 * Returns true if a message was already produced by a compaction pass
 * (i.e., it carries the SUMMARY_SENTINEL string in its content).
 */
function isCompactedSummary(message: any): boolean {
  if (typeof message?.content === 'string') {
    return message.content.includes(SUMMARY_SENTINEL) || message.content.includes(COMPACTED_MARKER_SENTINEL);
  }
  if (Array.isArray(message?.content)) {
    return message.content.some(
      (b: any) => b?.type === 'text' && typeof b.text === 'string' && (b.text.includes(SUMMARY_SENTINEL) || b.text.includes(COMPACTED_MARKER_SENTINEL))
    );
  }
  return false;
}

function blockText(block: any): string {
  if (!block) return '';
  if (typeof block === 'string') return block;
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'thinking' && typeof block.thinking === 'string') return `[thinking] ${block.thinking}`;
  if (block.type === 'tool_use') {
    return `[Action: Call ${block.name} with ${JSON.stringify(block.input || {})}]`;
  }
  if (block.type === 'tool_result') {
    const content = Array.isArray(block.content) 
      ? block.content.map((c: any) => c.text || '[data]').join(' ')
      : typeof block.content === 'string' ? block.content : '[data]';
    return `[Result: ${clip(normalizeWhitespace(content), 150)}]`;
  }
  if (block.type === 'image') return '[image]';
  return JSON.stringify(block);
}

function messageText(message: any, raw: boolean = false): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return JSON.stringify(message.content || {});
  
  return message.content.map((block: any) => {
    if (raw && block.type === 'tool_result') {
      return typeof block.content === 'string' ? block.content : JSON.stringify(block.content || {});
    }
    return blockText(block);
  }).join('\n');
}

function estimateTokens(messages: any[]): number {
  return messages.reduce((sum, msg) => {
    // For estimation, we MUST use the raw text length, not the clipped summary text
    let tokens = messageText(msg, true).length * TOKEN_WEIGHTS.CHAR;
    if (Array.isArray(msg.content)) {
      msg.content.forEach((b: any) => {
        if (b.type === 'image') tokens += TOKEN_WEIGHTS.IMAGE;
        if (b.type === 'tool_use') tokens += TOKEN_WEIGHTS.TOOL_CALL;
      });
    }
    return sum + Math.ceil(tokens);
  }, 0);
}

/**
 * Ensures we don't slice history in a way that orphans a tool result from its call.
 */
function findSafeBoundary(messages: any[], index: number): number {
  let safeIdx = index;
  
  while (safeIdx > 0 && safeIdx < messages.length) {
    const current = messages[safeIdx];
    const prev = messages[safeIdx - 1];
    
    // If current is a user message with tool results, it MUST have the previous 
    // assistant message with tool calls in the same part of history.
    if (hasToolResult(current) && !hasToolUse(current)) {
       safeIdx--;
       continue; 
    }
    
    // If the assistant just made a call (current), and we are about to START 
    // the kept history here, we must make sure we didn't just cut off its result.
    // However, since we are moving BACKWARDS from the end, if 'current' is an 
    // assistant tool_use, it's safer to include it in the kept history so the 
    // model sees its own pending call.
    break;
  }
  return Math.max(0, safeIdx);
}

function findRecentFailureAnchor(messages: any[], startIndex: number, keepFailures: number): number | null {
  let kept = 0;
  let anchor: number | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!Array.isArray(msg?.content)) continue;

    const hasFailure = msg.content.some((b: any) => isToolFailureBlock(b));
    if (!hasFailure) continue;

    kept++;
    // Include the preceding assistant tool_use message when present.
    const prev = messages[i - 1];
    const prevIsToolUse = prev?.role === 'assistant' && hasToolUse(prev);
    anchor = prevIsToolUse ? i - 1 : i;

    if (kept >= keepFailures) break;
  }

  if (anchor == null) return null;
  return Math.min(anchor, startIndex);
}

function findPendingToolAnchor(messages: any[], startIndex: number): number | null {
  const resolved = new Set<string>();

  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resolved.add(block.tool_use_id);
      }
    }
  }

  const windowStart = Math.max(0, startIndex - 40);
  for (let i = startIndex - 1; i >= windowStart; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg?.content)) continue;
    const hasPending = msg.content.some((block: any) => block?.type === 'tool_use' && typeof block.id === 'string' && !resolved.has(block.id));
    if (hasPending) return i;
  }

  return null;
}

function extractLikelyPaths(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/(?:[A-Za-z]:[\\/]|\.{0,2}\/)?[\w.-]+(?:[\\/][\w.@-]+)+/g) || [];
  return Array.from(new Set(matches)).slice(0, 12);
}

function firstNonEmptyLine(text: string): string {
  const line = text
    .split('\n')
    .map(l => l.trim())
    .find(Boolean);
  return line || '';
}

function buildOperationalHeuristicSummary(
  freshTurns: any[],
  rollingSummary: string,
  summaryCharBudget: number
): string {
  const recentUser = [...freshTurns]
    .reverse()
    .find(m => m?.role === 'user' && normalizeWhitespace(messageText(m)).length > 0);
  const recentAssistant = [...freshTurns]
    .reverse()
    .find(m => m?.role === 'assistant' && normalizeWhitespace(messageText(m)).length > 0);

  const currentGoal = clip(firstNonEmptyLine(normalizeWhitespace(messageText(recentUser))), 220);
  const latestState = clip(firstNonEmptyLine(normalizeWhitespace(messageText(recentAssistant))), 220);

  const pathSet = new Set<string>();
  const failures: string[] = [];
  const pending: string[] = [];

  const toolNameById = new Map<string, string>();
  for (const msg of freshTurns) {
    if (!Array.isArray(msg?.content)) continue;
    for (const b of msg.content) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        toolNameById.set(b.id, b.name || 'tool');
      }
    }
  }

  for (const msg of freshTurns) {
    const txt = messageText(msg);
    for (const p of extractLikelyPaths(txt)) pathSet.add(p);

    if (typeof txt === 'string') {
      const lines = txt.split('\n');
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        if (/^[-*]\s*\[\s\]/.test(t) || /\b(todo|next steps?|pending|remaining)\b/i.test(t)) {
          pending.push(clip(t, 180));
        }
      }
    }

    if (Array.isArray(msg?.content)) {
      for (const b of msg.content) {
        if (isToolFailureBlock(b)) {
          const toolName = toolNameById.get(b.tool_use_id) || 'tool';
          const err = clip(firstNonEmptyLine(normalizeWhitespace(toolResultText(b))), 180);
          failures.push(`${toolName}: ${err}`);
        }
      }
    }
  }

  const lines: string[] = [];
  if (rollingSummary) {
    lines.push(`Previous memory: ${clip(normalizeWhitespace(rollingSummary), Math.floor(summaryCharBudget * 0.25))}`);
  }
  if (currentGoal) lines.push(`Current goal: ${currentGoal}`);
  if (latestState) lines.push(`Latest working state: ${latestState}`);
  if (failures.length > 0) {
    lines.push('Failed attempts:');
    for (const f of failures.slice(-6)) lines.push(`- ${f}`);
  }
  if (pathSet.size > 0) {
    lines.push(`Active files/paths: ${Array.from(pathSet).slice(0, 10).join(', ')}`);
  }
  if (pending.length > 0) {
    lines.push('Pending subtasks:');
    for (const p of pending.slice(-8)) lines.push(`- ${p}`);
  }

  if (lines.length === 0) {
    const fallbackLines = freshTurns.slice(-15).map(msg => {
      const role = msg.role === 'assistant' ? 'AI' : 'User';
      return `${role}: ${clip(normalizeWhitespace(messageText(msg)), 200)}`;
    });
    lines.push('Recent Discussion:');
    for (const ln of fallbackLines) lines.push(`- ${ln}`);
  }

  return clip(lines.join('\n'), summaryCharBudget);
}

export async function compactMessagesDetailed(
  messages: any[],
  options: CompactionOptions = {}
): Promise<CompactionResult> {
  const {
    maxMessages = DEFAULT_OPTIONS.maxMessages!,
    maxTokensApprox = DEFAULT_OPTIONS.maxTokensApprox!,
    keepFirstN = DEFAULT_OPTIONS.keepFirstN!,
    keepLastN = DEFAULT_OPTIONS.keepLastN!,
    rollingSummary = '',
    summaryCharBudget = DEFAULT_OPTIONS.summaryCharBudget!,
    failureAnchorDepth = DEFAULT_OPTIONS.failureAnchorDepth!,
    conversationId = '',
    compactedRangeTtlSeconds = Number(process.env.CONTEXT_COMPACTED_RANGE_TTL || 86400),
  } = options;

  const estimatedTokensBefore = estimateTokens(messages);
  const belowLimits = messages.length <= maxMessages && estimatedTokensBefore <= maxTokensApprox;
  
  if (belowLimits) {
    return {
      messages,
      didCompact: false,
      originalMessageCount: messages.length,
      compactedMessageCount: messages.length,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  // 1. Calculate boundaries safely
  const firstPartEnd = keepFirstN;
  let lastPartStart = Math.max(firstPartEnd + 1, messages.length - keepLastN);
  
  // Shift boundary to avoid breaking tool sequences
  lastPartStart = findSafeBoundary(messages, lastPartStart);

  // Preserve recent failure chains so retries remain grounded in actual errors.
  const failureAnchor = findRecentFailureAnchor(messages, lastPartStart, failureAnchorDepth);
  if (failureAnchor != null) {
    lastPartStart = Math.min(lastPartStart, failureAnchor);
  }

  // Preserve pending tool dependency chains (tool_use awaiting tool_result).
  const pendingAnchor = findPendingToolAnchor(messages, lastPartStart);
  if (pendingAnchor != null) {
    lastPartStart = Math.min(lastPartStart, pendingAnchor);
  }

  const firstPart = messages.slice(0, firstPartEnd);
  const removedPart = messages.slice(firstPartEnd, lastPartStart);
  const lastPart = messages.slice(lastPartStart);

  if (removedPart.length === 0) {
    return {
      messages,
      didCompact: false,
      originalMessageCount: messages.length,
      compactedMessageCount: messages.length,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  // 2. Separate already-compacted summaries from fresh turns to avoid re-processing.
  const alreadyCompacted = removedPart.filter(isCompactedSummary);
  const freshTurns       = removedPart.filter(m => !isCompactedSummary(m));

  if (alreadyCompacted.length > 0) {
    console.log(`[Compaction] Skipping ${alreadyCompacted.length} already-compacted message(s); processing ${freshTurns.length} fresh turn(s).`);
  } else {
    console.log(`[Compaction] Shrinking ${messages.length} messages. Removed middle ${removedPart.length} turns.`);
  }

  // 3. Generate Summary (AI-powered with heuristic fallback)
  let summary = "";
  let generatedByAI = false;

  const CHUNK_SIZE = Number(process.env.COMPACTION_CHUNK_SIZE || 20);

  if (options.apiKey && freshTurns.length > 0) {
    const aiSummary = await generateChunkedSummary(
      freshTurns,
      options.apiKey,
      options.model || 'gemma-4-31b-it',
      CHUNK_SIZE
    );
    if (aiSummary) {
      summary = aiSummary;
      generatedByAI = true;
    }
  }

  if (!generatedByAI && freshTurns.length > 0) {
    summary = buildOperationalHeuristicSummary(freshTurns, rollingSummary, summaryCharBudget);
  }

  // 4. Persist compacted range metadata and emit a sentinel-backed block.
  const rangeStart = firstPartEnd;
  const rangeEnd = Math.max(firstPartEnd, lastPartStart - 1);
  const rangeId = buildCompactedRangeId(freshTurns, rangeStart, rangeEnd);
  if (conversationId && summary) {
    await saveCompactedSummary(conversationId, rangeId, summary, compactedRangeTtlSeconds).catch(() => {});
  }
  const summaryContent = buildStoredSummaryMessage(rangeId, summary || rollingSummary || 'N/A');
  
  // Already-compacted summaries are promoted into firstPart so they survive
  // every subsequent compaction cycle without ever being re-summarized.
  const compacted: any[] = [...firstPart, ...alreadyCompacted];
  const firstOfLast = lastPart[0];

  if (firstOfLast && firstOfLast.role === 'user') {
    // Merge summary into the beginning of the next user message
    const newContent = typeof firstOfLast.content === 'string'
      ? `${summaryContent}\n\n${firstOfLast.content}`
      : [{ type: 'text', text: summaryContent }, ...firstOfLast.content];
    
    compacted.push({ ...firstOfLast, content: newContent });
    compacted.push(...lastPart.slice(1));
  } else {
    // If next is assistant, we MUST insert a user message with the summary
    compacted.push({
      role: 'user',
      content: `${summaryContent}\n\nPlease continue based on the summary above.`
    });
    compacted.push(...lastPart);
  }

  const estimatedTokensAfter = estimateTokens(compacted);
  return {
    messages: compacted,
    didCompact: true,
    originalMessageCount: messages.length,
    compactedMessageCount: compacted.length,
    estimatedTokensBefore,
    estimatedTokensAfter,
    generatedSummary: summary,
  };
}

export async function compactMessages(messages: any[], options: CompactionOptions = {}): Promise<any[]> {
  const res = await compactMessagesDetailed(messages, options);
  return res.messages;
}
