/**
 * Message history compaction logic for the CoatCard AI Gateway.
 *
 * Prevents context window overflows by intelligently shrinking the message
 * history when it exceeds a target threshold.
 */

export interface CompactionOptions {
  maxMessages?: number;
  maxTokensApprox?: number;
  keepFirstN?: number;
  keepLastN?: number;
  rollingSummary?: string;
  summaryCharBudget?: number;
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
  maxTokensApprox: 100000, // ~100k tokens
  keepFirstN: 2,           // Keep the initial context-setting exchange
  keepLastN: 10,           // Keep the most recent context
  summaryCharBudget: 3000,
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, maxChars: number): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function blockText(block: any): string {
  if (!block) return '';
  if (typeof block === 'string') return block;
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'thinking' && typeof block.thinking === 'string') return `[thinking] ${block.thinking}`;
  if (block.type === 'tool_use') {
    return `[tool_use:${block.name || 'unknown'}] ${JSON.stringify(block.input || {})}`;
  }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return `[tool_result] ${block.content}`;
    if (Array.isArray(block.content)) {
      const merged = block.content
        .map((entry: any) => {
          if (entry?.type === 'text') return entry.text || '';
          if (entry?.type === 'image') return '[image]';
          return typeof entry === 'string' ? entry : JSON.stringify(entry);
        })
        .join(' ');
      return `[tool_result] ${merged}`;
    }
    return `[tool_result] ${JSON.stringify(block.content || {})}`;
  }
  if (block.type === 'image') return '[image]';
  if (typeof block.text === 'string') return block.text;
  return JSON.stringify(block);
}

function messageText(message: any): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return JSON.stringify(message.content || {});
  return message.content.map((block: any) => blockText(block)).join('\n');
}

function estimateTokens(messages: any[]): number {
  const chars = messages.reduce((sum, msg) => sum + messageText(msg).length, 0);
  return Math.ceil(chars / 4);
}

function buildSummaryLines(messages: any[], maxLines: number): string[] {
  const lines: string[] = [];
  for (const msg of messages) {
    if (lines.length >= maxLines) break;
    const role = msg?.role || 'unknown';
    const text = clip(normalizeWhitespace(messageText(msg)), 220);
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }
  return lines;
}

function buildCompactionSummary(
  removedMessages: any[],
  rollingSummary: string,
  summaryCharBudget: number
): string {
  const existing = rollingSummary ? clip(normalizeWhitespace(rollingSummary), Math.floor(summaryCharBudget * 0.45)) : '';
  const lines = buildSummaryLines(removedMessages, 14);

  const sections: string[] = [];
  if (existing) sections.push(`Previous summary:\n${existing}`);
  if (lines.length > 0) sections.push(`Compressed turns:\n- ${lines.join('\n- ')}`);
  if (sections.length === 0) {
    return 'Older context compressed to preserve token budget.';
  }

  const summary = sections.join('\n\n');
  return clip(summary, summaryCharBudget);
}

export function compactMessagesDetailed(
  messages: any[],
  options: CompactionOptions = {}
): CompactionResult {
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

  console.log(`[Compaction] Triggered (${messages.length} messages, ~${estimatedTokensBefore} tokens).`);

  if (messages.length <= keepFirstN + keepLastN) {
    return {
      messages,
      didCompact: false,
      originalMessageCount: messages.length,
      compactedMessageCount: messages.length,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  const firstPart = messages.slice(0, keepFirstN);
  const removedPart = messages.slice(keepFirstN, Math.max(keepFirstN, messages.length - keepLastN));
  const lastPart = messages.slice(-keepLastN);

  const summary = buildCompactionSummary(removedPart, rollingSummary, summaryCharBudget);

  const summaryMarker = {
    role: 'assistant',
    content: `[Gateway Memory Summary]\n${summary}`,
  };

  const compacted = [...firstPart, summaryMarker, ...lastPart];
  const estimatedTokensAfter = estimateTokens(compacted);

  console.log(`[Compaction] ${messages.length} -> ${compacted.length} messages (~${estimatedTokensBefore} -> ~${estimatedTokensAfter} tokens).`);
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

export function compactMessages(messages: any[], options: CompactionOptions = {}): any[] {
  return compactMessagesDetailed(messages, options).messages;
}
