/**
 * tests/model-racer.test.ts
 * Tests for parallel model racing.
 */

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

import { raceModels } from '../lib/racing/model-racer';
import { getHealthiestKeyObj } from '../lib/key-manager';
import { callGemini } from '../lib/gemini-adapter';

const mockGetKey = getHealthiestKeyObj as jest.Mock;
const mockCallGemini = callGemini as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('raceModels', () => {
  test('returns null when no keys available', async () => {
    mockGetKey.mockResolvedValue(null);
    const result = await raceModels({ models: ['m1', 'm2'], body: {}, stream: false });
    expect(result).toBeNull();
  });

  test('single model — no race', async () => {
    mockGetKey.mockResolvedValueOnce({ id: 'k1', key: 'api1' });
    mockCallGemini.mockResolvedValue({ ok: true, status: 200 });

    const result = await raceModels({ models: ['gemini-2.5-flash'], body: {}, stream: false });
    expect(result).not.toBeNull();
    expect(result!.model).toBe('gemini-2.5-flash');
    expect(result!.racedModels).toBe(1);
  });

  test('multi-model race — first OK wins', async () => {
    let keyIdx = 0;
    mockGetKey.mockImplementation(() => {
      keyIdx++;
      return Promise.resolve({ id: `k${keyIdx}`, key: `api${keyIdx}` });
    });

    mockCallGemini.mockImplementation((model: string) => {
      if (model === 'gemini-3-flash-preview') return Promise.resolve({ ok: true, status: 200 });
      return Promise.resolve({ ok: false, status: 503 });
    });

    const result = await raceModels({
      models: ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'],
      body: {},
      stream: false,
    });
    expect(result).not.toBeNull();
    expect(result!.model).toBe('gemini-3-flash-preview');
    expect(result!.racedModels).toBe(3);
  });

  test('all models fail — returns null', async () => {
    mockGetKey.mockResolvedValue({ id: 'k1', key: 'api1' });
    mockCallGemini.mockResolvedValue({ ok: false, status: 503 });

    const result = await raceModels({ models: ['m1', 'm2'], body: {}, stream: false });
    expect(result).toBeNull();
  });

  test('bodyTransformer is applied per model', async () => {
    let keyIdx = 0;
    mockGetKey.mockImplementation(() => {
      keyIdx++;
      return Promise.resolve({ id: `k${keyIdx}`, key: `api${keyIdx}` });
    });
    mockCallGemini.mockResolvedValue({ ok: true, status: 200 });

    const transformer = jest.fn((model: string, b: any) => ({ ...b, model }));
    await raceModels({
      models: ['m1', 'm2'],
      body: { original: true },
      stream: false,
      bodyTransformer: transformer,
    });

    expect(transformer).toHaveBeenCalledTimes(2);
    expect(transformer).toHaveBeenCalledWith('m1', { original: true });
    expect(transformer).toHaveBeenCalledWith('m2', { original: true });
  });
});
