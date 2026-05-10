jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      _store: store,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
      del: jest.fn(async (...keys: string[]) => { keys.forEach((k) => store.delete(k)); return keys.length; }),
    },
  };
});

import { redis } from '../lib/redis';
import {
  getFileSnapshot,
  isSnapshotFresh,
  recordFileSnapshot,
} from '../lib/tools/tool-failure-memory';

const mockRedis = redis as any;

describe('snapshot freshness', () => {
  beforeEach(() => {
    mockRedis._store.clear();
    jest.resetAllMocks();
    const store = mockRedis._store;
    mockRedis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
    mockRedis.set.mockImplementation(async (key: string, value: string) => { store.set(key, value); return 'OK'; });
    mockRedis.del.mockImplementation(async (...keys: string[]) => { keys.forEach((k: string) => store.delete(k)); return keys.length; });
  });

  test('records and loads snapshot hash', async () => {
    const rec = await recordFileSnapshot('sess1', '/src/a.ts', 'const a = 1;\n');
    expect(rec).not.toBeNull();

    const loaded = await getFileSnapshot('sess1', '/src/a.ts');
    expect(loaded?.filePath).toBe('/src/a.ts');
    expect(loaded?.contentHash).toBeTruthy();
  });

  test('normalizes CRLF/LF to same hash', async () => {
    const rec1 = await recordFileSnapshot('sess1', '/src/a.ts', 'line1\r\nline2\r\n');
    const rec2 = await recordFileSnapshot('sess1', '/src/a.ts', 'line1\nline2\n');
    expect(rec1?.contentHash).toBe(rec2?.contentHash);
  });

  test('snapshot is fresh immediately after record', async () => {
    await recordFileSnapshot('sess1', '/src/a.ts', 'const x = 1;');
    const fresh = await isSnapshotFresh('sess1', '/src/a.ts', 120_000);
    expect(fresh).toBe(true);
  });

  test('missing snapshot is not fresh', async () => {
    const fresh = await isSnapshotFresh('sess1', '/src/missing.ts', 120_000);
    expect(fresh).toBe(false);
  });
});
