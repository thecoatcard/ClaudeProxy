export {};

jest.mock('@/lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'key-1', key: 'api-key' }),
  reportKeyFailure: jest.fn().mockResolvedValue(undefined),
  recordKeyUsage: jest.fn().mockResolvedValue(undefined),
}));

const redisMock = {
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(1),
};

jest.mock('@/lib/redis', () => ({
  redis: redisMock,
}));

jest.mock('@/lib/gemini-adapter', () => ({
  callGemini: jest.fn(),
}));

jest.mock('@/lib/cache-manager', () => ({
  splitForCache: jest.fn().mockReturnValue(null),
  prefixHash: jest.fn(),
  lookupCache: jest.fn(),
  saveCache: jest.fn(),
  deleteCache: jest.fn(),
  createCachedContent: jest.fn(),
  isCacheSupported: jest.fn().mockReturnValue(false),
}));

jest.mock('@/lib/recovery/overload-recovery', () => ({
  isOverloadError: jest.fn(() => true),
  isRecoverableError: jest.fn(() => true),
  recoverFromOverload: jest.fn().mockResolvedValue({ recovered: false, backoffMs: 0 }),
  compactBodyForOverload: jest.fn(),
  detectTokenPressure: jest.fn(() => false),
  computeOverloadBackoff: jest.fn(() => 0),
  RECOVERY_CHAIN_SIZE: 3,
}));

jest.mock('@/lib/logging/event-logger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

jest.mock('@/lib/logging/error-summarizer', () => ({
  errorOneLiner: jest.fn((err: unknown) => String(err)),
}));

jest.mock('@/lib/racing/key-racer', () => ({
  raceKeys: jest.fn(),
  getDynamicKeyCount: jest.fn(() => 1),
}));

jest.mock('@/lib/racing/model-racer', () => ({
  raceModels: jest.fn(),
  getDynamicModelRaceConfig: jest.fn(() => ({ enabled: false, modelCount: 0 })),
}));

jest.mock('@/lib/metrics/performance-tracker', () => ({
  startTimer: jest.fn(() => ({
    record: jest.fn().mockResolvedValue(undefined),
    elapsed: jest.fn(() => 0),
  })),
}));

jest.mock('@/lib/context/emergency-compactor', () => ({
  performEmergencyCompaction: jest.fn().mockResolvedValue({ compacted: false, hardFallback: false }),
}));

jest.mock('@/lib/admin-settings', () => ({
  getAdminSystemSettings: jest.fn().mockResolvedValue({ racingEnabled: false }),
}));

import { callGemini } from '@/lib/gemini-adapter';
import { executeWithRetry } from '@/lib/retry-engine';

describe('retry engine sticky routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears the sticky route before switching away from a 503 primary model', async () => {
    (callGemini as jest.Mock)
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });

    const response = await executeWithRetry(
      'claude-sonnet-4-5',
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      false,
      'user-123',
      { primary: 'gemini-2.5-flash', fallback: ['gemini-3-flash-preview'], routeVersion: '7' },
      'req-1'
    );

    expect(response.ok).toBe(true);
    expect(redisMock.del).toHaveBeenCalledWith('route:last:v7:user-123:claude-sonnet-4-5');
    expect(redisMock.set).toHaveBeenCalledWith(
      'route:last:v7:user-123:claude-sonnet-4-5',
      'gemini-3-flash-preview',
      { ex: 3600 } // 60 min sticky route TTL
    );
  });
});