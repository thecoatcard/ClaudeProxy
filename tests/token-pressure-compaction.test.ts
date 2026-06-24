/**
 * tests/token-pressure-compaction.test.ts
 * Tests for token-pressure based compaction (not just turn count).
 */

jest.mock('../lib/compactor/ai-compactor', () => ({
  buildCompactedRangeId: jest.fn().mockReturnValue('range-1'),
  buildStoredSummaryMessage: jest.fn().mockReturnValue('<!-- compacted:v1 -->Summary'),
  COMPACTED_MARKER_SENTINEL: '<!-- ai-compacted -->',
  generateChunkedSummary: jest.fn().mockResolvedValue(null),
  saveCompactedSummary: jest.fn().mockResolvedValue(undefined),
}));

import { compactMessagesDetailed } from '../lib/transformers/compaction';

describe('Token-pressure compaction', () => {
  test('compacts when token pressure is high even with few messages', async () => {
    // 20 messages, each with 25K chars → ~6.25K tokens each → ~125K total (above 100K default)
    // 20 messages is below maxMessages=50, but token pressure triggers compaction
    const bigContent = 'x'.repeat(25_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: bigContent,
    }));

    const result = await compactMessagesDetailed(messages, {
      maxMessages: 50, // message count is fine (20 < 50)
      maxTokensApprox: 100_000, // but tokens exceed this
    });

    expect(result.didCompact).toBe(true);
    expect(result.compactedMessageCount).toBeLessThan(result.originalMessageCount);
  });

  test('does not compact when both limits are within bounds', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];

    const result = await compactMessagesDetailed(messages, {
      maxMessages: 50,
      maxTokensApprox: 100_000,
    });

    expect(result.didCompact).toBe(false);
  });

  test('does not compact when only message count is high', async () => {
    // 60 messages, each tiny → message count exceeds limit
    const messages = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
    }));

    const result = await compactMessagesDetailed(messages, {
      maxMessages: 50,
      maxTokensApprox: 1_000_000,
    });

    expect(result.didCompact).toBe(false);
  });
});
