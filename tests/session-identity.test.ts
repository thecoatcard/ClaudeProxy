/**
 * tests/session-identity.test.ts
 *
 * Unit tests for Phase 1 — Hard Session Identity.
 * Covers: nonce generation, Redis persistence, TTL refresh, fallback on error.
 */

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      _store: store,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
      expire: jest.fn(async () => 1),
      del: jest.fn(async (...keys: string[]) => { keys.forEach((k) => store.delete(k)); return keys.length; }),
    },
  };
});

import { redis } from '../lib/redis';
import {
  getOrCreateSessionNonce,
  deriveHardSessionId,
  deriveSlotHash,
} from '../lib/session/session-identity';

const mockRedis = redis as any;

beforeEach(() => {
  mockRedis._store.clear();
  jest.clearAllMocks();
});

describe('deriveSlotHash', () => {
  it('returns a deterministic hex string', () => {
    const h1 = deriveSlotHash('user1', 'system text', 'first message');
    const h2 = deriveSlotHash('user1', 'system text', 'first message');
    expect(h1).toBe(h2);
    expect(typeof h1).toBe('string');
    expect(h1.length).toBeGreaterThan(0);
  });

  it('differs for different users', () => {
    const h1 = deriveSlotHash('user1', 'system', 'hello');
    const h2 = deriveSlotHash('user2', 'system', 'hello');
    expect(h1).not.toBe(h2);
  });

  it('truncates long system text to 200 chars', () => {
    const longSystem = 'x'.repeat(1000);
    const h1 = deriveSlotHash('u', longSystem, 'msg');
    const h2 = deriveSlotHash('u', 'x'.repeat(200), 'msg');
    expect(h1).toBe(h2);
  });
});

describe('getOrCreateSessionNonce', () => {
  it('creates a nonce when none exists', async () => {
    const nonce = await getOrCreateSessionNonce('slot-abc');
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThan(0);
    expect(mockRedis.set).toHaveBeenCalledWith('session:nonce:slot-abc', nonce, expect.objectContaining({ ex: expect.any(Number) }));
  });

  it('returns the same nonce on repeat calls', async () => {
    const n1 = await getOrCreateSessionNonce('slot-xyz');
    const n2 = await getOrCreateSessionNonce('slot-xyz');
    expect(n1).toBe(n2);
  });

  it('refreshes TTL on subsequent reads', async () => {
    await getOrCreateSessionNonce('slot-ttl');
    await getOrCreateSessionNonce('slot-ttl');
    // expire should be called on the second read
    expect(mockRedis.expire).toHaveBeenCalledWith('session:nonce:slot-ttl', expect.any(Number));
  });

  it('returns a non-empty string even when Redis set fails', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis down'));
    mockRedis.set.mockRejectedValueOnce(new Error('Redis down'));
    const nonce = await getOrCreateSessionNonce('slot-err');
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThan(0);
  });

  it('produces different nonces for different slots', async () => {
    const n1 = await getOrCreateSessionNonce('slot-A');
    const n2 = await getOrCreateSessionNonce('slot-B');
    // Statistically extremely unlikely to collide
    expect(n1).not.toBe(n2);
  });
});

describe('deriveHardSessionId', () => {
  it('returns a string starting with "anon-"', () => {
    const id = deriveHardSessionId('user1', 'fp-abc', 'nonce-123');
    expect(id).toMatch(/^anon-/);
  });

  it('is deterministic for the same inputs', () => {
    const id1 = deriveHardSessionId('user1', 'fp-abc', 'nonce-123');
    const id2 = deriveHardSessionId('user1', 'fp-abc', 'nonce-123');
    expect(id1).toBe(id2);
  });

  it('differs when nonce differs (different sessions, same workspace)', () => {
    const id1 = deriveHardSessionId('user1', 'same-fp', 'nonce-A');
    const id2 = deriveHardSessionId('user1', 'same-fp', 'nonce-B');
    expect(id1).not.toBe(id2);
  });

  it('differs when workspace fingerprint differs', () => {
    const id1 = deriveHardSessionId('user1', 'fp-workspace-A', 'same-nonce');
    const id2 = deriveHardSessionId('user1', 'fp-workspace-B', 'same-nonce');
    expect(id1).not.toBe(id2);
  });
});
