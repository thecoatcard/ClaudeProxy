/**
 * tests/embedding-engine.test.ts
 * Tests for lib/memory/embedding-engine.ts
 */

// Mock the key-manager before importing
jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'test-key-1', key: 'fake-api-key' }),
  reportKeyFailure: jest.fn(),
}));

// Mock global fetch
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  embedText,
  embedBatch,
  embedFile,
  embedSummary,
  cosineSimilarity,
  EMBEDDING_DIMENSION,
} from '../lib/memory/embedding-engine';

function fakeVector(seed: number = 1): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => Math.sin(seed + i) * 0.5);
}

function mockEmbedResponse(vector: number[]) {
  return {
    ok: true,
    json: async () => ({
      embedding: { values: vector },
    }),
  };
}

function mockBatchEmbedResponse(vectors: number[][]) {
  return {
    ok: true,
    json: async () => ({
      embeddings: vectors.map((v) => ({ values: v })),
    }),
  };
}

describe('embedding-engine', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const v = [1, 0, 0];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });

    it('should return 0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
    });

    it('should return -1 for opposite vectors', () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
    });

    it('should handle zero vectors', () => {
      expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    });
  });

  describe('embedText', () => {
    it('should embed text and return vector', async () => {
      const vec = fakeVector(1);
      mockFetch.mockResolvedValueOnce(mockEmbedResponse(vec));

      const result = await embedText('hello world');
      expect(result.vector).toEqual(vec);
      expect(result.text).toBe('hello world');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw when no API key is available', async () => {
      const { getHealthiestKeyObj } = require('../lib/key-manager');
      getHealthiestKeyObj.mockResolvedValueOnce(null);

      await expect(embedText('test')).rejects.toThrow('No API key available');
    });

    it('should truncate long text', async () => {
      const vec = fakeVector(2);
      mockFetch.mockResolvedValueOnce(mockEmbedResponse(vec));

      const longText = 'a'.repeat(35000);
      const result = await embedText(longText);
      expect(result.text.length).toBeLessThanOrEqual(30000);
    });
  });

  describe('embedBatch', () => {
    it('should embed multiple texts', async () => {
      const vecs = [fakeVector(1), fakeVector(2)];
      mockFetch.mockResolvedValueOnce(mockBatchEmbedResponse(vecs));

      const results = await embedBatch(['text1', 'text2']);
      expect(results.embeddings).toHaveLength(2);
      expect(results.embeddings[0].vector).toEqual(vecs[0]);
      expect(results.embeddings[1].vector).toEqual(vecs[1]);
    });
  });

  describe('embedFile', () => {
    it('should add file context to embedding', async () => {
      const vec = fakeVector(3);
      mockFetch.mockResolvedValueOnce(mockEmbedResponse(vec));

      const result = await embedFile('src/utils.ts', 'export function add(a, b) { return a + b; }');
      expect(result.vector).toEqual(vec);
      // Verify that the file path was prepended
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content.parts[0].text).toContain('src/utils.ts');
    });
  });

  describe('embedSummary', () => {
    it('should add summary type to embedding', async () => {
      const vec = fakeVector(4);
      mockFetch.mockResolvedValueOnce(mockEmbedResponse(vec));

      const result = await embedSummary('task', 'Auth Flow', 'Implemented JWT authentication');
      expect(result.vector).toEqual(vec);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content.parts[0].text).toContain('[TASK]');
      expect(body.content.parts[0].text).toContain('Auth Flow');
    });
  });

  describe('EMBEDDING_DIMENSION', () => {
    it('should be 768 for text-embedding-004', () => {
      expect(EMBEDDING_DIMENSION).toBe(768);
    });
  });
});
