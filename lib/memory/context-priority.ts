/**
 * lib/memory/context-priority.ts
 *
 * Defines and enforces context priority ordering.
 * Priority: recent raw turns > operational memory > active task memory
 *           > embedding retrieval > compactor summaries
 *
 * Embedding retrieval must NOT override recent context.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum ContextLayer {
  /** Most recent user/assistant turns (highest priority) */
  RECENT_TURNS = 1,
  /** Operational state and guidance */
  OPERATIONAL_MEMORY = 2,
  /** Active task context from subagent orchestration */
  ACTIVE_TASK_MEMORY = 3,
  /** Embedding-based retrieval from vector index */
  EMBEDDING_RETRIEVAL = 4,
  /** AI compactor summaries (lowest priority) */
  COMPACTOR_SUMMARIES = 5,
}

export interface ContextBlock {
  /** Priority layer */
  layer: ContextLayer;
  /** Label for this block */
  label: string;
  /** The context text */
  text: string;
  /** Estimated token count */
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum total tokens for injected context across all layers */
const MAX_TOTAL_CONTEXT_TOKENS = 8000;

/** Per-layer token budgets */
const LAYER_BUDGETS: Record<ContextLayer, number> = {
  [ContextLayer.RECENT_TURNS]: 0, // Not capped (part of the message array)
  [ContextLayer.OPERATIONAL_MEMORY]: 2000,
  [ContextLayer.ACTIVE_TASK_MEMORY]: 2000,
  [ContextLayer.EMBEDDING_RETRIEVAL]: 2000,
  [ContextLayer.COMPACTOR_SUMMARIES]: 2000,
};

export { MAX_TOTAL_CONTEXT_TOKENS, LAYER_BUDGETS };

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Merge context blocks respecting priority ordering and token budgets.
 * Higher-priority layers take precedence over lower-priority ones.
 *
 * @param blocks - Context blocks from various layers
 * @param totalBudget - Total token budget (default 8000)
 * @returns Ordered array of blocks that fit within budget
 */
export function mergeContextByPriority(
  blocks: ContextBlock[],
  totalBudget: number = MAX_TOTAL_CONTEXT_TOKENS
): ContextBlock[] {
  // Sort by priority (lower number = higher priority)
  const sorted = [...blocks].sort((a, b) => a.layer - b.layer);

  const result: ContextBlock[] = [];
  let usedTokens = 0;

  for (const block of sorted) {
    if (block.layer === ContextLayer.RECENT_TURNS) {
      // Recent turns are never filtered — they're in the message array
      result.push(block);
      continue;
    }

    const layerBudget = LAYER_BUDGETS[block.layer] ?? 2000;
    const available = Math.min(layerBudget, totalBudget - usedTokens);

    if (available <= 0) break;

    if (block.estimatedTokens <= available) {
      result.push(block);
      usedTokens += block.estimatedTokens;
    } else {
      // Truncate the block to fit
      const ratio = available / block.estimatedTokens;
      const truncatedText = block.text.slice(0, Math.floor(block.text.length * ratio));
      result.push({
        ...block,
        text: truncatedText,
        estimatedTokens: available,
      });
      usedTokens += available;
    }
  }

  return result;
}

/**
 * Build the final system prompt addition from merged context blocks.
 */
export function buildContextInjection(blocks: ContextBlock[]): string {
  const merged = mergeContextByPriority(blocks);

  // Skip RECENT_TURNS (they're in the message array, not system prompt)
  const injectionBlocks = merged.filter(
    (b) => b.layer !== ContextLayer.RECENT_TURNS
  );

  if (injectionBlocks.length === 0) return '';

  return injectionBlocks.map((b) => b.text).join('\n\n');
}

/**
 * Create a context block from retrieval results.
 */
export function createRetrievalBlock(
  formattedContext: string
): ContextBlock | null {
  if (!formattedContext) return null;

  return {
    layer: ContextLayer.EMBEDDING_RETRIEVAL,
    label: 'Embedding Retrieval',
    text: formattedContext,
    estimatedTokens: Math.ceil(formattedContext.length / 4),
  };
}
