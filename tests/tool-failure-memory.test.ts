/**
 * tests/tool-failure-memory.test.ts
 *
 * Phase 9 tests — tool failure memory (Phase 6):
 *   - recordToolFailure: stores and increments count
 *   - getToolFailureCount: retrieves count
 *   - getToolFailureRecord: full record
 *   - hasIdenticalRecentFailure: duplicate detection
 *   - clearToolFailures: removes key
 *   - error handling: swallows Redis errors
 */

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      _store: store,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
      del: jest.fn(async (...keys: string[]) => { keys.forEach(k => store.delete(k)); return keys.length; }),
    },
  };
});

import { redis } from '../lib/redis';
import {
  recordToolFailure,
  getToolFailureCount,
  getToolFailureRecord,
  hasIdenticalRecentFailure,
  clearToolFailures,
} from '../lib/tools/tool-failure-memory';

const mockRedis = redis as any;

beforeEach(() => {
  mockRedis._store.clear();
  // Reset all mocks (clears once-queues AND implementations), then re-attach
  jest.resetAllMocks();
  const store = mockRedis._store;
  mockRedis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  mockRedis.set.mockImplementation(async (key: string, value: string) => { store.set(key, value); return 'OK'; });
  mockRedis.del.mockImplementation(async (...keys: string[]) => { keys.forEach((k: string) => store.delete(k)); return keys.length; });
});

// ── recordToolFailure ─────────────────────────────────────────────────────────

describe('recordToolFailure', () => {
  test('stores a failure record with count 1', async () => {
    await recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'EXACT_MATCH_FAILURE');
    const count = await getToolFailureCount('sess1', 'edit_file', '/src/a.ts');
    expect(count).toBe(1);
  });

  test('increments count on repeated calls', async () => {
    await recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'EXACT_MATCH_FAILURE');
    await recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'EXACT_MATCH_FAILURE');
    const count = await getToolFailureCount('sess1', 'edit_file', '/src/a.ts');
    expect(count).toBe(2);
  });

  test('different file paths tracked separately', async () => {
    await recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'EXACT_MATCH_FAILURE');
    await recordToolFailure('sess1', 'edit_file', '/src/b.ts', 'WHITESPACE_MISMATCH');
    expect(await getToolFailureCount('sess1', 'edit_file', '/src/a.ts')).toBe(1);
    expect(await getToolFailureCount('sess1', 'edit_file', '/src/b.ts')).toBe(1);
  });

  test('different sessions tracked separately', async () => {
    await recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'EXACT_MATCH_FAILURE');
    await recordToolFailure('sess2', 'edit_file', '/src/a.ts', 'EXACT_MATCH_FAILURE');
    expect(await getToolFailureCount('sess1', 'edit_file', '/src/a.ts')).toBe(1);
    expect(await getToolFailureCount('sess2', 'edit_file', '/src/a.ts')).toBe(1);
  });

  test('does not throw on Redis error', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis down'));
    mockRedis.set.mockRejectedValueOnce(new Error('Redis down'));
    await expect(
      recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'EXACT_MATCH_FAILURE')
    ).resolves.toBeUndefined();
  });

  test('stores the last reason', async () => {
    await recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'WHITESPACE_MISMATCH');
    const record = await getToolFailureRecord('sess1', 'edit_file', '/src/a.ts');
    expect(record?.lastReason).toBe('WHITESPACE_MISMATCH');
  });

  test('updates lastReason on second call', async () => {
    await recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'EXACT_MATCH_FAILURE');
    await recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'MULTIPLE_MATCHES');
    const record = await getToolFailureRecord('sess1', 'edit_file', '/src/a.ts');
    expect(record?.lastReason).toBe('MULTIPLE_MATCHES');
    expect(record?.count).toBe(2);
  });
});

// ── getToolFailureCount ───────────────────────────────────────────────────────

describe('getToolFailureCount', () => {
  test('returns 0 for unknown key', async () => {
    const count = await getToolFailureCount('sess_x', 'edit_file', '/nope.ts');
    expect(count).toBe(0);
  });

  test('returns 0 on Redis error', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis down'));
    const count = await getToolFailureCount('sess1', 'edit_file', '/src/a.ts');
    expect(count).toBe(0);
  });
});

// ── getToolFailureRecord ──────────────────────────────────────────────────────

describe('getToolFailureRecord', () => {
  test('returns null for missing key', async () => {
    const record = await getToolFailureRecord('sess_x', 'edit_file', '/nope.ts');
    expect(record).toBeNull();
  });

  test('returns null on Redis error', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis down'));
    const record = await getToolFailureRecord('sess1', 'edit_file', '/src/a.ts');
    expect(record).toBeNull();
  });

  test('includes toolName and filePath', async () => {
    await recordToolFailure('sess1', 'edit_file', '/src/a.ts', 'UNKNOWN');
    const record = await getToolFailureRecord('sess1', 'edit_file', '/src/a.ts');
    expect(record?.toolName).toBe('edit_file');
    expect(record?.filePath).toBe('/src/a.ts');
  });
});

// ── hasIdenticalRecentFailure ─────────────────────────────────────────────────

describe('hasIdenticalRecentFailure', () => {
  test('false when no failures recorded', async () => {
    const result = await hasIdenticalRecentFailure('sess1', 'edit_file', '/a.ts', 'EXACT_MATCH_FAILURE');
    expect(result).toBe(false);
  });

  test('true when same reason was last recorded', async () => {
    await recordToolFailure('sess1', 'edit_file', '/a.ts', 'EXACT_MATCH_FAILURE');
    const result = await hasIdenticalRecentFailure('sess1', 'edit_file', '/a.ts', 'EXACT_MATCH_FAILURE');
    expect(result).toBe(true);
  });

  test('false when reason differs', async () => {
    await recordToolFailure('sess1', 'edit_file', '/a.ts', 'WHITESPACE_MISMATCH');
    const result = await hasIdenticalRecentFailure('sess1', 'edit_file', '/a.ts', 'EXACT_MATCH_FAILURE');
    expect(result).toBe(false);
  });

  test('false on Redis error', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis down'));
    const result = await hasIdenticalRecentFailure('sess1', 'edit_file', '/a.ts', 'EXACT_MATCH_FAILURE');
    expect(result).toBe(false);
  });
});

// ── clearToolFailures ─────────────────────────────────────────────────────────

describe('clearToolFailures', () => {
  test('removes the failure record', async () => {
    await recordToolFailure('sess1', 'edit_file', '/a.ts', 'EXACT_MATCH_FAILURE');
    await clearToolFailures('sess1', 'edit_file', '/a.ts');
    const count = await getToolFailureCount('sess1', 'edit_file', '/a.ts');
    expect(count).toBe(0);
  });

  test('does not throw when key does not exist', async () => {
    await expect(clearToolFailures('sess1', 'edit_file', '/nonexistent.ts')).resolves.toBeUndefined();
  });

  test('does not throw on Redis error', async () => {
    mockRedis.del.mockRejectedValueOnce(new Error('Redis down'));
    await expect(clearToolFailures('sess1', 'edit_file', '/a.ts')).resolves.toBeUndefined();
  });
});
