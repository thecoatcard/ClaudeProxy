/**
 * tests/key-racer.test.ts
 * Tests for parallel key racing.
 */

// Mock dependencies before imports
jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn(),
  reportKeyFailure: jest.fn().mockResolvedValue(undefined),
  recordKeyUsage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/gemini-adapter', () => ({
  callGemini: jest.fn(),
}));

jest.mock('../lib/logging/event-logger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

jest.mock('../lib/redis', () => ({
  redis: {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
  },
}));

import { raceKeys } from '../lib/racing/key-racer';
import { getHealthiestKeyObj } from '../lib/key-manager';
import { callGemini } from '../lib/gemini-adapter';

const mockGetKey = getHealthiestKeyObj as jest.Mock;
const mockCallGemini = callGemini as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('raceKeys', () => {
  test('returns null when no keys available', async () => {
    mockGetKey.mockResolvedValue(null);
    const result = await raceKeys({ model: 'gemini-2.5-flash', body: {}, stream: false });
    expect(result).toBeNull();
  });

  test('single key — no race, direct call', async () => {
    mockGetKey.mockResolvedValueOnce({ id: 'k1', key: 'api1' });
    mockGetKey.mockResolvedValue(null);
    mockCallGemini.mockResolvedValue({ ok: true, status: 200 });

    const result = await raceKeys({ model: 'gemini-2.5-flash', body: {}, stream: false });
    expect(result).not.toBeNull();
    expect(result!.keyId).toBe('k1');
    expect(result!.racedKeys).toBe(1);
  });

  test('multi-key race — fastest wins', async () => {
    mockGetKey
      .mockResolvedValueOnce({ id: 'k1', key: 'api1' })
      .mockResolvedValueOnce({ id: 'k2', key: 'api2' })
      .mockResolvedValueOnce({ id: 'k3', key: 'api3' });

    // k2 responds fastest with ok
    mockCallGemini
      .mockImplementation((_model: string, apiKey: string) => {
        if (apiKey === 'api2') return Promise.resolve({ ok: true, status: 200 });
        // Others fail
        return Promise.resolve({ ok: false, status: 503 });
      });

    const result = await raceKeys({ model: 'gemini-2.5-flash', body: {}, stream: false, keyCount: 3 });
    expect(result).not.toBeNull();
    expect(result!.keyId).toBe('k2');
    expect(result!.racedKeys).toBe(3);
  });

  test('all keys fail — returns null', async () => {
    mockGetKey
      .mockResolvedValueOnce({ id: 'k1', key: 'api1' })
      .mockResolvedValueOnce({ id: 'k2', key: 'api2' });
    mockCallGemini.mockResolvedValue({ ok: false, status: 503 });

    const result = await raceKeys({ model: 'gemini-2.5-flash', body: {}, stream: false, keyCount: 2 });
    expect(result).toBeNull();
  });

  test('duplicate keys are deduplicated', async () => {
    // Returns same key twice
    mockGetKey.mockResolvedValue({ id: 'k1', key: 'api1' });
    mockCallGemini.mockResolvedValue({ ok: true, status: 200 });

    const result = await raceKeys({ model: 'gemini-2.5-flash', body: {}, stream: false, keyCount: 3 });
    // Should only race 1 key since all are same id
    expect(result).not.toBeNull();
    expect(result!.racedKeys).toBe(1);
  });

  test('reports failures for non-OK keys', async () => {
    const { reportKeyFailure } = require('../lib/key-manager');
    mockGetKey
      .mockResolvedValueOnce({ id: 'k1', key: 'api1' })
      .mockResolvedValueOnce({ id: 'k2', key: 'api2' });

    mockCallGemini
      .mockImplementation((_m: string, apiKey: string) => {
        if (apiKey === 'api1') return Promise.resolve({ ok: false, status: 429 });
        return Promise.resolve({ ok: true, status: 200 });
      });

    await raceKeys({ model: 'test', body: {}, stream: false, keyCount: 2 });
    expect(reportKeyFailure).toHaveBeenCalledWith('k1', 'ratelimit');
  });
});
