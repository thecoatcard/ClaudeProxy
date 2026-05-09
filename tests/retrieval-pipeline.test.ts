/**
 * tests/retrieval-pipeline.test.ts
 * Tests for lib/memory/retrieval-pipeline.ts
 */

// Mock the embedding engine
jest.mock('../lib/memory/embedding-engine', () => ({
  embedText: jest.fn(),
  cosineSimilarity: jest.fn((a: number[], b: number[]) => {
    // Simple dot product for 3D unit-like vectors
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
    return dot;
  }),
  EMBEDDING_DIMENSION: 3,
}));

import {
  retrieveContext,
  formatRetrievalContext,
  extractQueryFromBody,
  MAX_RETRIEVAL_RESULTS,
  MIN_SIMILARITY_THRESHOLD,
} from '../lib/memory/retrieval-pipeline';
import { VectorIndex } from '../lib/memory/vector-index';

// Mock VectorIndex disk operations
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

const { embedText } = require('../lib/memory/embedding-engine');

describe('retrieval-pipeline', () => {
  let index: VectorIndex;

  beforeEach(() => {
    index = new VectorIndex('/fake');
    jest.clearAllMocks();
  });

  describe('retrieveContext', () => {
    it('should return empty when index is empty', async () => {
      const result = await retrieveContext('test query', index);
      expect(result.retrieved).toBe(false);
      expect(result.snippets).toHaveLength(0);
    });

    it('should retrieve relevant entries', async () => {
      index.insert({
        id: 'file1',
        vector: [1, 0, 0],
        metadata: { type: 'file', title: 'utils.ts', text: 'utility functions', embeddedAt: 1 },
      });
      index.insert({
        id: 'file2',
        vector: [0, 0, 1],
        metadata: { type: 'file', title: 'styles.css', text: 'styling rules', embeddedAt: 1 },
      });

      embedText.mockResolvedValueOnce({ vector: [1, 0, 0], text: 'test' });

      const result = await retrieveContext('test query', index);
      expect(result.retrieved).toBe(true);
      expect(result.snippets.length).toBeGreaterThan(0);
      expect(result.snippets[0].source).toBe('utils.ts');
    });

    it('should respect topK limit', async () => {
      for (let i = 0; i < 10; i++) {
        index.insert({
          id: `file${i}`,
          vector: [1 - i * 0.05, i * 0.05, 0],
          metadata: { type: 'file', title: `file${i}.ts`, text: `content ${i}`, embeddedAt: 1 },
        });
      }

      embedText.mockResolvedValueOnce({ vector: [1, 0, 0], text: 'test' });

      const result = await retrieveContext('test', index, 3);
      expect(result.snippets.length).toBeLessThanOrEqual(3);
    });

    it('should handle embed failure gracefully', async () => {
      index.insert({
        id: 'file1',
        vector: [1, 0, 0],
        metadata: { type: 'file', title: 'a.ts', text: 'content', embeddedAt: 1 },
      });

      embedText.mockRejectedValueOnce(new Error('API error'));

      const result = await retrieveContext('test', index);
      expect(result.retrieved).toBe(false);
    });
  });

  describe('formatRetrievalContext', () => {
    it('should return empty string when no snippets', () => {
      expect(formatRetrievalContext({ snippets: [], estimatedTokens: 0, retrieved: false })).toBe('');
    });

    it('should format snippets with headers', () => {
      const result = formatRetrievalContext({
        snippets: [
          { source: 'utils.ts', type: 'file', score: 0.9, text: 'helper functions' },
        ],
        estimatedTokens: 10,
        retrieved: true,
      });

      expect(result).toContain('Relevant Project Context');
      expect(result).toContain('utils.ts');
      expect(result).toContain('90%');
    });
  });

  describe('extractQueryFromBody', () => {
    it('should extract from Anthropic format', () => {
      const body = {
        messages: [
          { role: 'user', content: 'first message' },
          { role: 'assistant', content: 'response' },
          { role: 'user', content: 'latest question' },
        ],
      };
      expect(extractQueryFromBody(body)).toBe('latest question');
    });

    it('should extract from Anthropic content blocks', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'text', text: 'world' },
            ],
          },
        ],
      };
      expect(extractQueryFromBody(body)).toBe('hello\nworld');
    });

    it('should extract from Gemini format', () => {
      const body = {
        contents: [
          { role: 'user', parts: [{ text: 'gemini query' }] },
        ],
      };
      expect(extractQueryFromBody(body)).toBe('gemini query');
    });

    it('should return empty for unknown format', () => {
      expect(extractQueryFromBody({})).toBe('');
      expect(extractQueryFromBody(null)).toBe('');
    });
  });

  describe('constants', () => {
    it('should have sensible defaults', () => {
      expect(MAX_RETRIEVAL_RESULTS).toBe(5);
      expect(MIN_SIMILARITY_THRESHOLD).toBe(0.3);
    });
  });
});
