/**
 * Message history compaction logic for the CoatCard AI Gateway.
 */
import { generateSemanticSummary, generateChunkedSummary } from './ai-compactor';

export interface CompactionOptions {
  maxMessages?: number;
  maxTokensApprox?: number;
  keepFirstN?: number;
  keepLastN?: number;
  rollingSummary?: string;
  summaryCharBudget?: number;
  // If provided, used to call AI for semantic summarization
  apiKey?: string;
  model?: string;
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
    return message.content.includes(SUMMARY_SENTINEL);
  }
  if (Array.isArray(message?.content)) {
    return message.content.some(
      (b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes(SUMMARY_SENTINEL)
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
    const existing = rollingSummary ? clip(normalizeWhitespace(rollingSummary), Math.floor(summaryCharBudget * 0.4)) : '';
    const lines = freshTurns.slice(-15).map(msg => {
      const role = msg.role === 'assistant' ? 'AI' : 'User';
      return `${role}: ${clip(normalizeWhitespace(messageText(msg)), 200)}`;
    });
    summary = (existing ? `Previous: ${existing}\n\n` : "") + "Recent Discussion:\n- " + lines.join('\n- ');
    summary = clip(summary, summaryCharBudget);
  }

  // 4. Insert Summary while maintaining role alternation.
  // Stamp the sentinel so future passes can identify and skip this message.
  const summaryContent = `${SUMMARY_SENTINEL}\n[CONTEXT SUMMARY]\n${summary}\n[END SUMMARY]`;
  
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
