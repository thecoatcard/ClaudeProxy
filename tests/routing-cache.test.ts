import assert from 'node:assert/strict';
import {
  __resetRoutingTestAdapters,
  __setRoutingTestAdapters,
  forceReloadRouting,
  getModelMapping,
  saveRoutingRegistry,
} from '../lib/model-router.js';

class FakeRedis {
  private store: Record<string, string> = {};

  async get<T = string>(key: string): Promise<T | null> {
    return (this.store[key] as T) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store[key] = String(value);
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.store[key] ?? '0') + 1;
    this.store[key] = String(next);
    return next;
  }
}

function makeTaskBody(text: string) {
  return { messages: [{ role: 'user', content: text }] };
}

afterEach(async () => {
  await __resetRoutingTestAdapters();
});

describe('routing cache invalidation', () => {
  test('forceReloadRouting refreshes in-memory registry cache', async () => {
    const fake = new FakeRedis();
    await __setRoutingTestAdapters({ redisClient: fake, localRegistry: null });

    await fake.set('models:registry', JSON.stringify({
      'claude-sonnet-4-5': { primary: 'gemini-2.5-flash', fallback: [] },
    }));
    await fake.set('models:registry:version', '1');

    const first = await getModelMapping('claude-sonnet-4-5', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    assert.equal(first.routeVersion, '1');

    await fake.set('models:registry', JSON.stringify({
      'claude-sonnet-4-5': { primary: 'gemini-3-flash-preview', fallback: [] },
    }));
    await fake.set('models:registry:version', '2');

    const reloaded = await forceReloadRouting();
    assert.equal(reloaded.version, '2');

    const second = await getModelMapping('claude-sonnet-4-5', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    assert.equal(second.primary, 'gemini-3-flash-preview');
    assert.equal(second.routeVersion, '2');
  });

  test('saveRoutingRegistry increments version and applies without restart', async () => {
    const fake = new FakeRedis();
    await __setRoutingTestAdapters({ redisClient: fake, localRegistry: null });

    const before = await getModelMapping('claude-opus-4-5', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    const initialVersion = before.routeVersion ?? '0';

    const diag = await saveRoutingRegistry({
      'claude-opus-4-5': {
        primary: 'gemini-3-flash-preview',
        fallback: ['gemini-2.5-flash'],
      },
    });

    const after = await getModelMapping('claude-opus-4-5', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    assert.equal(diag.source, 'redis');
    assert.notEqual(diag.version, initialVersion);
    assert.equal(after.primary, 'gemini-3-flash-preview');
  });
});
