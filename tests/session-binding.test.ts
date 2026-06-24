/**
 * tests/session-binding.test.ts
 *
 * Unit tests for Phase 4 — Session Token Binding.
 * Covers: save, load, validate, delete, mismatch detection.
 */

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      _store: store,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, options?: any) => {
        // Handle NX (only set if key doesn't exist)
        if (options?.nx && store.has(key)) {
          return null; // NX failure: key already exists
        }
        store.set(key, value);
        return 'OK';
      }),
      expire: jest.fn(async () => 1),
      del: jest.fn(async (...keys: string[]) => { keys.forEach((k) => store.delete(k)); return keys.length; }),
    },
  };
});

import { redis } from '../lib/redis';
import {
  loadSessionBinding,
  saveSessionBinding,
  validateBinding,
  deleteSessionBinding,
} from '../lib/session/session-binding';
import { stableHash } from '../lib/utils/hash';

const mockRedis = redis as any;

beforeEach(() => {
  mockRedis._store.clear();
  jest.clearAllMocks();
});

describe('saveSessionBinding', () => {
  it('stores binding in Redis as JSON', async () => {
    await saveSessionBinding('conv-123', 'user-token', 'fp-abc', 'nonce-xyz');
    const key = 'session:binding:conv-123';
    const stored = mockRedis._store.get(key);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored);
    expect(parsed.userHash).toBe(stableHash('user-token'));
    expect(parsed.workspaceFingerprint).toBe('fp-abc');
    expect(parsed.nonce).toBe('nonce-xyz');
    expect(typeof parsed.createdAt).toBe('number');
  });

  it('does not overwrite an existing binding', async () => {
    await saveSessionBinding('conv-abc', 'user-1', 'fp-1', 'nonce-1');
    const firstStored = mockRedis._store.get('session:binding:conv-abc');
    await saveSessionBinding('conv-abc', 'user-2', 'fp-2', 'nonce-2');
    const afterStored = mockRedis._store.get('session:binding:conv-abc');
    // Should remain the FIRST binding (NX semantics)
    expect(firstStored).toBe(afterStored);
  });

  it('refreshes TTL on subsequent save calls', async () => {
    await saveSessionBinding('conv-ttl', 'user-1', 'fp-1', 'nonce-1');
    await saveSessionBinding('conv-ttl', 'user-1', 'fp-1', 'nonce-1');
    expect(mockRedis.expire).toHaveBeenCalledWith('session:binding:conv-ttl', expect.any(Number));
  });
});

describe('loadSessionBinding', () => {
  it('returns null when no binding exists', async () => {
    const binding = await loadSessionBinding('conv-nonexistent');
    expect(binding).toBeNull();
  });

  it('loads and parses a stored binding', async () => {
    await saveSessionBinding('conv-load', 'user-token', 'fp-fingerprint', 'nonce-abc');
    const binding = await loadSessionBinding('conv-load');
    expect(binding).not.toBeNull();
    expect(binding!.userHash).toBe(stableHash('user-token'));
    expect(binding!.workspaceFingerprint).toBe('fp-fingerprint');
  });

  it('returns null on Redis error', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis error'));
    const binding = await loadSessionBinding('conv-err');
    expect(binding).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    mockRedis._store.set('session:binding:conv-bad', 'not-json{{{');
    const binding = await loadSessionBinding('conv-bad');
    expect(binding).toBeNull();
  });
});

describe('validateBinding', () => {
  it('returns "new" when binding is null', () => {
    expect(validateBinding(null, 'user', 'fp')).toBe('new');
  });

  it('returns "valid" when userId and fingerprint match', () => {
    const binding = {
      userHash: stableHash('user-token'),
      workspaceFingerprint: 'fp-abc',
      nonce: 'n',
      createdAt: Date.now(),
    };
    expect(validateBinding(binding, 'user-token', 'fp-abc')).toBe('valid');
  });

  it('returns "mismatch" when userId differs', () => {
    const binding = {
      userHash: stableHash('user-A'),
      workspaceFingerprint: 'fp-abc',
      nonce: 'n',
      createdAt: Date.now(),
    };
    expect(validateBinding(binding, 'user-B', 'fp-abc')).toBe('mismatch');
  });

  it('returns "mismatch" when workspace fingerprint differs', () => {
    const binding = {
      userHash: stableHash('user-token'),
      workspaceFingerprint: 'fp-workspace-A',
      nonce: 'n',
      createdAt: Date.now(),
    };
    expect(validateBinding(binding, 'user-token', 'fp-workspace-B')).toBe('mismatch');
  });

  it('returns "valid" when either fingerprint is the unknown fallback (00000000)', () => {
    const binding = {
      userHash: stableHash('user-token'),
      workspaceFingerprint: '00000000',  // unknown stored
      nonce: 'n',
      createdAt: Date.now(),
    };
    // Current request has a real fingerprint — should not mismatch the unknown stored
    expect(validateBinding(binding, 'user-token', 'fp-real')).toBe('valid');
  });

  it('returns "valid" when current fingerprint is the fallback', () => {
    const binding = {
      userHash: stableHash('user-token'),
      workspaceFingerprint: 'fp-stored',
      nonce: 'n',
      createdAt: Date.now(),
    };
    // Current request has no workspace → unknown (00000000)
    expect(validateBinding(binding, 'user-token', '00000000')).toBe('valid');
  });
});

describe('deleteSessionBinding', () => {
  it('removes the binding from Redis', async () => {
    await saveSessionBinding('conv-del', 'user', 'fp', 'nonce');
    expect(mockRedis._store.has('session:binding:conv-del')).toBe(true);
    await deleteSessionBinding('conv-del');
    expect(mockRedis._store.has('session:binding:conv-del')).toBe(false);
  });

  it('does not throw when key does not exist', async () => {
    await expect(deleteSessionBinding('conv-missing')).resolves.not.toThrow();
  });
});
