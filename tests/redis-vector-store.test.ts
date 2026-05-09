/**
 * tests/redis-vector-store.test.ts
 *
 * Tests for Redis-backed vector storage.
 */

// Mock Redis
const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  sadd: jest.fn(),
  srem: jest.fn(),
  smembers: jest.fn(),
  expire: jest.fn(),
};
jest.mock('@/lib/redis', () => ({ redis: mockRedis }));
jest.mock('./embedding-engine', () => ({
  cosineSimilarity: jest.fn((a: number[], b: number[]) => {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }),
}));
jest.mock('@/lib/memory/project-memory-path', () => ({
  getWorkspaceId: () => 'test/project',
  isLocalCacheEnabled: () => false,
  getVectorsFilePath: () => '/tmp/test-vectors.json',
}));

import { RedisVectorStore } from '@/lib/memory/redis-vector-store';
import type { VectorEntry } from '@/lib/memory/vector-index';

function makeEntry(id: string, vector: number[] = [1, 0, 0]): VectorEntry {
  return {
    id,
    vector,
    metadata: {
      type: 'file',
      title: id,
      text: `content of ${id}`,
      embeddedAt: Date.now(),
    },
  };
}

describe('RedisVectorStore', () => {
  let store: RedisVectorStore;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new RedisVectorStore('test/project');
  });

  test('insert writes entry and adds to index set', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.sadd.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);

    const entry = makeEntry('file1.ts');
    await store.insert(entry);

    expect(mockRedis.set).toHaveBeenCalledWith(
      'vec:test/project:entry:file1.ts',
      expect.any(String),
      { ex: expect.any(Number) },
    );
    expect(mockRedis.sadd).toHaveBeenCalledWith('vec:test/project:index', 'file1.ts');
  });

  test('get returns parsed entry', async () => {
    const entry = makeEntry('file2.ts');
    mockRedis.get.mockResolvedValue(JSON.stringify(entry));

    const result = await store.get('file2.ts');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('file2.ts');
  });

  test('get returns null for missing entry', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await store.get('missing.ts');
    expect(result).toBeNull();
  });

  test('remove deletes entry and removes from index', async () => {
    mockRedis.del.mockResolvedValue(1);
    mockRedis.srem.mockResolvedValue(1);

    const result = await store.remove('file1.ts');
    expect(result).toBe(true);
    expect(mockRedis.del).toHaveBeenCalledWith('vec:test/project:entry:file1.ts');
    expect(mockRedis.srem).toHaveBeenCalledWith('vec:test/project:index', 'file1.ts');
  });

  test('search returns top-k results sorted by similarity', async () => {
    const entries = [
      makeEntry('exact.ts', [1, 0, 0]),
      makeEntry('partial.ts', [0.7, 0.7, 0]),
      makeEntry('unrelated.ts', [0, 0, 1]),
    ];

    mockRedis.smembers.mockResolvedValue(entries.map((e) => e.id));
    for (const entry of entries) {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(entry));
    }

    const results = await store.search([1, 0, 0], 2);
    expect(results.length).toBe(2);
    expect(results[0].entry.id).toBe('exact.ts');
    expect(results[0].score).toBeCloseTo(1.0);
  });

  test('removeByPrefix removes matching entries', async () => {
    mockRedis.smembers.mockResolvedValue(['lib/a.ts', 'lib/b.ts', 'src/c.ts']);
    mockRedis.del.mockResolvedValue(1);
    mockRedis.srem.mockResolvedValue(1);

    const count = await store.removeByPrefix('lib/');
    expect(count).toBe(2);
  });

  test('has returns true when entry exists', async () => {
    mockRedis.get.mockResolvedValue('{}');
    const result = await store.has('file1.ts');
    expect(result).toBe(true);
  });

  test('has returns false when entry missing', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await store.has('missing.ts');
    expect(result).toBe(false);
  });

  test('size counts entries from index set', async () => {
    mockRedis.smembers.mockResolvedValue(['a', 'b', 'c']);
    const count = await store.size();
    expect(count).toBe(3);
  });

  test('update modifies existing entry', async () => {
    const entry = makeEntry('file1.ts', [1, 0, 0]);
    mockRedis.get.mockResolvedValue(JSON.stringify(entry));
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.sadd.mockResolvedValue(0);
    mockRedis.expire.mockResolvedValue(1);

    const result = await store.update('file1.ts', [0, 1, 0], { title: 'updated' });
    expect(result).toBe(true);
  });

  test('update returns false for missing entry', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await store.update('missing.ts', [0, 1, 0], {});
    expect(result).toBe(false);
  });

  test('workspace isolation: keys include workspace ID', async () => {
    const store2 = new RedisVectorStore('other/project');
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.sadd.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);

    await store2.insert(makeEntry('file.ts'));
    expect(mockRedis.set).toHaveBeenCalledWith(
      'vec:other/project:entry:file.ts',
      expect.any(String),
      expect.any(Object),
    );
  });
});
