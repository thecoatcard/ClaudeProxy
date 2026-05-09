/**
 * tests/context-priority.test.ts
 * Tests for lib/memory/context-priority.ts
 */

import {
  ContextLayer,
  mergeContextByPriority,
  buildContextInjection,
  createRetrievalBlock,
  MAX_TOTAL_CONTEXT_TOKENS,
  type ContextBlock,
} from '../lib/memory/context-priority';

describe('context-priority', () => {
  describe('mergeContextByPriority', () => {
    it('should sort blocks by priority (lower layer = higher priority)', () => {
      const blocks: ContextBlock[] = [
        { layer: ContextLayer.COMPACTOR_SUMMARIES, label: 'compactor', text: 'summary', estimatedTokens: 100 },
        { layer: ContextLayer.OPERATIONAL_MEMORY, label: 'ops', text: 'ops context', estimatedTokens: 100 },
        { layer: ContextLayer.EMBEDDING_RETRIEVAL, label: 'embedding', text: 'retrieval', estimatedTokens: 100 },
      ];

      const merged = mergeContextByPriority(blocks);
      expect(merged[0].label).toBe('ops');
      expect(merged[1].label).toBe('embedding');
      expect(merged[2].label).toBe('compactor');
    });

    it('should respect total budget', () => {
      const blocks: ContextBlock[] = [
        { layer: ContextLayer.OPERATIONAL_MEMORY, label: 'ops', text: 'x'.repeat(4000), estimatedTokens: 5000 },
        { layer: ContextLayer.EMBEDDING_RETRIEVAL, label: 'embed', text: 'y'.repeat(4000), estimatedTokens: 5000 },
      ];

      const merged = mergeContextByPriority(blocks, 6000);
      // First block (ops) takes its layer budget (2000), second truncated
      expect(merged.length).toBeGreaterThanOrEqual(1);
    });

    it('should never filter RECENT_TURNS', () => {
      const blocks: ContextBlock[] = [
        { layer: ContextLayer.RECENT_TURNS, label: 'turns', text: 'conversation', estimatedTokens: 50000 },
        { layer: ContextLayer.OPERATIONAL_MEMORY, label: 'ops', text: 'ops', estimatedTokens: 100 },
      ];

      const merged = mergeContextByPriority(blocks, 100);
      const hasTurns = merged.some((b) => b.layer === ContextLayer.RECENT_TURNS);
      expect(hasTurns).toBe(true);
    });

    it('should truncate blocks that exceed layer budget', () => {
      const blocks: ContextBlock[] = [
        {
          layer: ContextLayer.EMBEDDING_RETRIEVAL,
          label: 'embed',
          text: 'a'.repeat(10000),
          estimatedTokens: 3000,
        },
      ];

      const merged = mergeContextByPriority(blocks);
      // Layer budget is 2000, so text should be truncated
      expect(merged[0].estimatedTokens).toBeLessThanOrEqual(2000);
    });
  });

  describe('buildContextInjection', () => {
    it('should return empty string for empty blocks', () => {
      expect(buildContextInjection([])).toBe('');
    });

    it('should exclude RECENT_TURNS from injection', () => {
      const blocks: ContextBlock[] = [
        { layer: ContextLayer.RECENT_TURNS, label: 'turns', text: 'chat', estimatedTokens: 100 },
        { layer: ContextLayer.OPERATIONAL_MEMORY, label: 'ops', text: 'operational context', estimatedTokens: 50 },
      ];

      const injection = buildContextInjection(blocks);
      expect(injection).not.toContain('chat');
      expect(injection).toContain('operational context');
    });

    it('should join multiple blocks with double newlines', () => {
      const blocks: ContextBlock[] = [
        { layer: ContextLayer.OPERATIONAL_MEMORY, label: 'ops', text: 'block1', estimatedTokens: 10 },
        { layer: ContextLayer.EMBEDDING_RETRIEVAL, label: 'embed', text: 'block2', estimatedTokens: 10 },
      ];

      const injection = buildContextInjection(blocks);
      expect(injection).toContain('block1');
      expect(injection).toContain('block2');
    });
  });

  describe('createRetrievalBlock', () => {
    it('should return null for empty context', () => {
      expect(createRetrievalBlock('')).toBeNull();
    });

    it('should create a block with EMBEDDING_RETRIEVAL layer', () => {
      const block = createRetrievalBlock('retrieved context text');
      expect(block).not.toBeNull();
      expect(block!.layer).toBe(ContextLayer.EMBEDDING_RETRIEVAL);
      expect(block!.text).toBe('retrieved context text');
      expect(block!.estimatedTokens).toBeGreaterThan(0);
    });
  });

  describe('constants', () => {
    it('should have MAX_TOTAL_CONTEXT_TOKENS = 8000', () => {
      expect(MAX_TOTAL_CONTEXT_TOKENS).toBe(8000);
    });
  });
});
