/**
 * tests/archive-recovery.test.ts
 *
 * Unit tests for Phase 6 — Tool Archive Miss Recovery.
 * Covers: successful retrieval, miss placeholder, recoverArchivedOutput, archiveToolOutput.
 */

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      _store: store,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, _opts?: any) => { store.set(key, value); return 'OK'; }),
      expire: jest.fn(async () => 1),
      del: jest.fn(async (...keys: string[]) => { keys.forEach((k) => store.delete(k)); return keys.length; }),
    },
  };
});

import { redis } from '../lib/redis';
import {
  archiveToolOutput,
  retrieveArchivedOutput,
  recoverArchivedOutput,
  buildArchiveMissPlaceholder,
} from '../lib/tool-archive';

const mockRedis = redis as any;

beforeEach(() => {
  mockRedis._store.clear();
  jest.clearAllMocks();
});

describe('buildArchiveMissPlaceholder', () => {
  it('returns a descriptive placeholder string', () => {
    const msg = buildArchiveMissPlaceholder('Read', 'abc123');
    expect(msg).toContain('GATEWAY ARCHIVE EXPIRED');
    expect(msg).toContain('Read');
    expect(msg).toContain('abc123');
    expect(msg).toContain('Re-run Read');
  });
});

describe('archiveToolOutput', () => {
  it('stores content in Redis and returns a reference tag', async () => {
    const content = 'x'.repeat(10000);
    const ref = await archiveToolOutput('session-key', 'Read', content);
    expect(ref).not.toBeNull();
    expect(ref).toContain('GATEWAY ARCHIVE');
    expect(ref).toContain('Read');
    expect(mockRedis.set).toHaveBeenCalled();
  });

  it('returns null on Redis error', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('Redis error'));
    const ref = await archiveToolOutput('session-key', 'Read', 'content');
    expect(ref).toBeNull();
  });

  it('same content produces same reference (deduplication)', async () => {
    const content = 'same content ' + 'x'.repeat(5000);
    const ref1 = await archiveToolOutput('session-A', 'Read', content);
    const ref2 = await archiveToolOutput('session-A', 'Read', content);
    expect(ref1).toBe(ref2);
  });
});

describe('retrieveArchivedOutput', () => {
  it('returns content when archived', async () => {
    const content = 'file content ' + 'x'.repeat(5000);
    const ref = await archiveToolOutput('session-key', 'Read', content);
    // Extract hash from ref
    const hashMatch = ref?.match(/ref:([a-z0-9]+)/);
    expect(hashMatch).not.toBeNull();
    const hash = hashMatch![1];

    const retrieved = await retrieveArchivedOutput('session-key', hash);
    expect(retrieved).toBe(content);
  });

  it('returns null when hash not found (cache miss)', async () => {
    const result = await retrieveArchivedOutput('session-key', 'nonexistent-hash');
    expect(result).toBeNull();
  });

  it('refreshes TTL on successful retrieval', async () => {
    const content = 'some content ' + 'x'.repeat(5000);
    const ref = await archiveToolOutput('session-key', 'Read', content);
    const hashMatch = ref?.match(/ref:([a-z0-9]+)/);
    const hash = hashMatch![1];

    jest.clearAllMocks();
    await retrieveArchivedOutput('session-key', hash);
    expect(mockRedis.expire).toHaveBeenCalled();
  });
});

describe('recoverArchivedOutput', () => {
  it('returns actual content on cache hit', async () => {
    const content = 'recovered content ' + 'x'.repeat(5000);
    const ref = await archiveToolOutput('session-key', 'Read', content);
    const hashMatch = ref?.match(/ref:([a-z0-9]+)/);
    const hash = hashMatch![1];

    const result = await recoverArchivedOutput('session-key', 'Read', hash);
    expect(result).toBe(content);
  });

  it('returns placeholder on cache miss (Phase 6 miss recovery)', async () => {
    const result = await recoverArchivedOutput('session-key', 'Read', 'missing-hash');
    expect(result).toContain('GATEWAY ARCHIVE EXPIRED');
    expect(result).toContain('Read');
    expect(result).toContain('missing-hash');
  });

  it('returns placeholder on Redis error', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis error'));
    const result = await recoverArchivedOutput('session-key', 'Bash', 'some-hash');
    expect(result).toContain('GATEWAY ARCHIVE EXPIRED');
    expect(result).toContain('Bash');
  });

  it('never returns null or empty string', async () => {
    const result = await recoverArchivedOutput('session-key', 'Write', 'ghost-hash');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });
});
